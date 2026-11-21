// Unreleased workspace API. This standalone script can submit transactions with --execute.
import {
    Contract,
    JsonRpcProvider,
    Wallet as EthereumWallet,
    ZeroAddress,
    parseUnits,
} from "ethers";

import { Invisi, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { settings } from "../settings.js";
import {
    PaymentMode,
    PaymentRouterClient,
    finalizeRouterPayment,
    ZeroExAdapter,
} from "@invisi-labs/payment-router";

const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
];

if (!process.argv.includes("--execute")) {
    console.log("Review this scenario and configure placeholders, then pass --execute");
    process.exit(0);
}

// Pin these addresses from reviewed deployment records, never from a quote response.
const routerAddress = "0x0000000000000000000000000000000000000000";
const coreAddress = "0x0000000000000000000000000000000000000000";
const wethAddress = "0x0000000000000000000000000000000000000000";
const uniswapRouterAddress = "0x0000000000000000000000000000000000000000";
const tokenIn = "0x0000000000000000000000000000000000000000";
const allowanceHolderAddress = "0x0000000000000000000000000000000000000000";
const settlerRegistryAddress = "0x0000000000000000000000000000000000000000";
const quoteProxyEndpoint = "https://PLACEHOLDER.invalid/zeroex-quote";
const tokenAddress = "0x0000000000000000000000000000000000000000";
if (
    [
        routerAddress,
        coreAddress,
        wethAddress,
        uniswapRouterAddress,
        tokenAddress,
        tokenIn,
        allowanceHolderAddress,
        settlerRegistryAddress,
    ].some((address) => address === ZeroAddress)
) {
    throw new Error(
        "Configure independently verified deployment and trust addresses before execution"
    );
}

if (quoteProxyEndpoint.includes("PLACEHOLDER")) {
    throw new Error("Configure the trusted 0x quote backend before execution");
}
if (tokenIn.toLowerCase() === tokenAddress.toLowerCase()) {
    throw new Error("Input ERC20 must differ from the Core output token");
}

const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required before connecting or sending");
}
const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (BigInt(protocol.context.protocolAddress) !== BigInt(coreAddress)) {
        throw new Error("Protocol RPC deployment does not match the pinned Core address");
    }
    const aliceSigner = new EthereumWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (aliceSigner.address.toLowerCase() !== alice.address.toLowerCase()) {
        throw new Error("ALICE_PRIVATE_KEY must match the configured payer");
    }
    const token = new Contract(tokenAddress, erc20Abi, aliceSigner);
    const decimals = Number(await token.decimals());
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin }),
    });
    const client = new PaymentRouterClient({
        provider,
        deployment: {
            chainId: settings.chainId,
            routerAddress,
            coreAddress,
            wethAddress,
            uniswapRouterAddress,
            zeroEx: {
                allowanceHolderAddress,
                settlerRegistryAddress,
            },
        },
    });
    const block = await provider.getBlock("latest");
    if (!block) {
        throw new Error("Missing latest block");
    }
    const deadline = BigInt(block.timestamp) + 3600n;
    // Public principal creates two hidden-amount Notes: real Core proof, no private inputs.
    const outputs = [
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("0.003", decimals),
            recipient: { type: "invisi", address: bob.receivingAddress },
        }),
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("0.007", decimals),
            recipient: { type: "invisi", address: alice.receivingAddress },
        }),
    ];
    const inputToken = new Contract(tokenIn, erc20Abi, aliceSigner);
    const inputDecimals = Number(await inputToken.decimals());
    const maxInput = parseUnits("0.02", inputDecimals);
    const prepared = await client.preparePayment({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        deadline,
    });
    // Trusted backend keeps its API key and returns the raw real 0x exact-buy response.
    // ZeroExAdapter validates calldata, target, amounts, deadline and pinned deployment.
    const adapter = new ZeroExAdapter({
        transport: async (request) => {
            const response = await fetch(quoteProxyEndpoint, {
                method: "POST",
                redirect: "error",
                headers: { "content-type": "application/json" },
                signal: request.signal
                    ? AbortSignal.any([request.signal, AbortSignal.timeout(30000)])
                    : AbortSignal.timeout(30000),
                body: JSON.stringify({
                    chainId: request.deployment.chainId.toString(),
                    sellToken: request.tokenIn,
                    buyToken: request.tokenOut,
                    buyAmount: request.amountOut.toString(),
                    maxSellAmount: request.maxInput.toString(),
                    taker: request.deployment.routerAddress,
                    recipient: request.deployment.routerAddress,
                    deadline: request.deadline.toString(),
                    slippageBps: request.slippageBps,
                }),
            });
            if (!response.ok) {
                throw new Error(`0x quote backend HTTP ${response.status}`);
            }
            return response.json();
        },
    });
    const swapQuote = await client.quote(adapter, {
        tokenIn,
        tokenOut: tokenAddress,
        amountOut: prepared.preview().funding.amount,
        maxInput,
        deadline,
        slippageBps: 50,
    });
    const draft = await client.prepareRouterPaymentDraft({
        payment: prepared,
        payer: alice.address,
        tokenIn,
        mode: PaymentMode.DirectToken,
        refundRecipient: alice.address,
        deadline: swapQuote.deadline,
        amountInMaximum: swapQuote.maxInput,
        quote: swapQuote,
    });
    // Prove the real Core operation. Public funding does not require a Provenance input proof.
    const ready = await prepared.prove();
    const coreCall = await ready.exportTransaction();
    const payment = finalizeRouterPayment(draft, coreCall);
    // Only approve the Router; do not approve a quote-provided Settler or third-party target.
    const allowance = await inputToken.allowance(alice.address, routerAddress);
    if (allowance < payment.intent.amountInMaximum) {
        if (allowance > 0n) {
            const reset = await inputToken.approve(routerAddress, 0n);
            console.log("Reset allowance transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await inputToken.approve(routerAddress, payment.intent.amountInMaximum);
        console.log("Router approval:", approval.hash);
        await approval.wait();
    }
    const outer = client.buildRouterTransaction(payment);
    const simulation = await client.simulateRouterPayment(outer, { from: alice.address });
    console.log("Final transaction simulated gas:", simulation.gasEstimate.toString());
    const transaction = await aliceSigner.sendTransaction(outer);
    console.log("Router transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Router transaction did not confirm successfully");
    }
    console.log("Confirmed block:", receipt.blockNumber);
} finally {
    provider.destroy();
}
