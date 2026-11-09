import { JsonRpcProvider, Contract, parseUnits } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../host-transport.js";

// Alice funds 10 tokens: Bob receives 3 and Alice receives 7 as private change.
// No existing note is spent; public cash funding and EVM submission remain host-owned.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const bob = accounts[1];
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }

    // 1. Validate the chain and trusted deployment before constructing this intent.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });

    // 2. Fund 10 whole tokens and send 3; the SDK creates Alice's 7-token change output.
    const token = new Contract(
        tokenAddress,
        ["function decimals() view returns (uint8)"],
        provider
    );
    const decimals = Number(await token.decimals());
    const cashAmount = parseUnits("10", decimals);
    const outputs = [
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("3", decimals),
            recipient: { type: "invisi", address: bob.receivingAddress },
        }),
    ];

    // Native approval and local proving may take time; on-chain time still bounds validity.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw Error("Missing latest block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;

    // 3. Caller funding requires Alice to submit and provide ERC20 allowance separately.
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        deadline,
        inputs: [],
        outputs,
        funding: { payer: alice.address, amount: cashAmount, authorization: "caller" },
    });
    // No existing notes are spent, so no private spending authorization is needed.
    // Hidden amounts still require a proof; this differs from transparent Shield.
    const ready = await prepared.prove();
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
