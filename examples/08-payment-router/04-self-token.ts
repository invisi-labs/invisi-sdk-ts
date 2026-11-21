// SDK 1.3.3 API. This standalone script can submit transactions with --execute.
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
const tokenAddress = "0x0000000000000000000000000000000000000000";
if (
    [routerAddress, coreAddress, wethAddress, uniswapRouterAddress, tokenAddress].some(
        (address) => address === ZeroAddress
    )
) {
    throw new Error(
        "Configure independently verified deployment and trust addresses before execution"
    );
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
    const maxInput = parseUnits("0.02", decimals);
    const prepared = await client.preparePayment({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        deadline,
    });
    const draft = await client.prepareRouterPaymentDraft({
        payment: prepared,
        payer: alice.address,
        tokenIn: tokenAddress,
        mode: PaymentMode.DirectToken,
        refundRecipient: alice.address,
        deadline,
        amountInMaximum: maxInput,
    });
    // Prove the real Core operation. Public funding does not require a Provenance input proof.
    const ready = await prepared.prove();
    const coreCall = await ready.exportTransaction();
    const payment = finalizeRouterPayment(draft, coreCall);
    // Only approve the Router; do not approve a quote-provided Settler or third-party target.
    const allowance = await token.allowance(alice.address, routerAddress);
    if (allowance < payment.intent.amountInMaximum) {
        if (allowance > 0n) {
            const reset = await token.approve(routerAddress, 0n);
            console.log("Reset allowance transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(routerAddress, payment.intent.amountInMaximum);
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
