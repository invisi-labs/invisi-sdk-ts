import { randomInt } from "node:crypto";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "./discover-candidates.js";

// Alice samples two notes and withdraws their complete amount publicly to herself.
// The exact full-owner, zero-fee withdrawal needs a proof but no private spend signature.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
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

    // 2. Discover all eligible notes first; selection stays explicit and local to this scenario.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        decryptor,
        tokenAddress,
    });
    const eligible = candidates.filter((input) => input.note.amount >= 1n);
    if (eligible.length < 2) {
        throw Error("Fewer than two eligible notes found; fund Alice and wait for indexing first");
    }
    const inputs = [
        eligible.splice(randomInt(eligible.length), 1)[0]!,
        eligible.splice(randomInt(eligible.length), 1)[0]!,
    ];
    const inputAmount = inputs.reduce((total, input) => total + input.note.amount, 0n);
    if (!inputAmount) {
        throw Error("No unspent notes found; fund Alice and wait for indexing first");
    }
    const outputs: NoteOutput[] = [];

    // Native approval and local proving may take time; on-chain time still bounds validity.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw Error("Missing latest block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;

    // 3. Freeze the financial intent; preparation rechecks membership and current spent state.
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        deadline,
        inputs,
        outputs,
        withdrawal: { to: alice.address, amount: inputAmount },
    });
    // Full withdrawal goes only to the original owner, with no private outputs or fee.
    // Changing any of those conditions would remove the signature exemption.
    const ready = await prepared.prove();
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
