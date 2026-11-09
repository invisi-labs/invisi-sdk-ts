import { JsonRpcProvider, Contract, parseUnits } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson, hostSignature } from "../host-transport.js";

// Bob authorizes 10 cash tokens; Bob receives 3 and Alice receives 7 as private change.
// Bob supplies token allowance while Alice can submit the final transaction and pay gas.
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

    // 3. Bob's funding signature allows Alice to submit while Bob supplies token allowance.
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        deadline,
        inputs: [],
        outputs,
        funding: { payer: bob.address, amount: cashAmount, authorization: "signature" },
    });
    // Prove the hidden-amount statement first; Bob then signs its final funding request.
    // With no existing notes, Alice needs no private spending authorization.
    const proved = await prepared.prove();
    const fundingRequest = await proved.exportFundingAuthorization();
    const fundingId = crypto.randomUUID();
    console.log(
        "Host EVM typed-data requests:",
        json([{ id: fundingId, kind: "funding", ...fundingRequest }])
    );
    const ready = await proved.withFundingSignature(hostSignature(await readHostJson(), fundingId));
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
