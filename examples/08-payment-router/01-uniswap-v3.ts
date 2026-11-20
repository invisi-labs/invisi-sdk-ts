import { Contract, JsonRpcProvider, parseUnits } from "ethers";
import { Invisi, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { PaymentRouterClient, UniswapV3Adapter } from "@invisi-labs/payment-router";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { routerSettings } from "./settings.js";

// Prepare, prove, quote, simulate and export. The host separately signs and submits.
if (!process.argv.includes("--execute")) {
    console.log("Configure verified Router dependencies, then pass --execute");
    process.exit(0);
}
const accounts = getAccounts(),
    alice = accounts[0],
    bob = accounts[1];
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });
    const client = new PaymentRouterClient({
        provider,
        deployment: {
            chainId: protocol.context.chainId,
            coreAddress: protocol.context.protocolAddress,
            routerAddress: routerSettings.routerAddress,
            wethAddress: routerSettings.wethAddress,
            uniswapRouterAddress: routerSettings.uniswapRouterAddress,
        },
    });
    const tokenAddress = settings.tokenAddress;
    const token = new Contract(tokenAddress, ["function decimals() view returns(uint8)"], provider);
    const decimals = Number(await token.decimals());
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Missing chain block");
    // Current pure-funding transact requires two Notes. Both requested recipients are explicit.
    const outputs = await Promise.all([
        NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("3", decimals),
            recipient: { type: "invisi", address: bob.receivingAddress },
        }),
        NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("7", decimals),
            recipient: { type: "invisi", address: alice.receivingAddress },
        }),
    ]);
    const prepared = await client.preparePayment({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        deadline: BigInt(block.timestamp) + 3600n,
    });
    const amountOut = prepared.preview().funding.amount;
    console.log("Fixed target-token funding:", amountOut.toString());
    // No private Note is consumed, so this path requires no private spending authorization.
    const ready = await prepared.prove();
    // Obtain a fresh short-lived quote after potentially expensive proof generation.
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("Missing quote block");
    const adapter = new UniswapV3Adapter({
        provider,
        quoterAddress: routerSettings.quoterV2Address,
        routes: [{ tokens: [routerSettings.wethAddress, tokenAddress], fees: [3000] }],
    });
    const quote = await client.quote(adapter, {
        tokenOut: tokenAddress,
        amountOut,
        maxInput: routerSettings.maxInput,
        deadline: BigInt(latest.timestamp) + 60n,
        slippageBps: 50,
    });
    const call = await client.buildPaymentTransaction({
        payment: ready,
        quote,
        refundRecipient: alice.address,
    });
    const simulation = await client.simulatePayment(call, { from: alice.address });
    console.log("Quote and full Router simulation:", json({ quote, simulation }));
    console.log("Unsigned Router transaction:", json(call));
} finally {
    provider.destroy();
}
