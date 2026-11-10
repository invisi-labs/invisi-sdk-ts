import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import {
    Provenance,
    officialProvenanceClient,
    type ProvenanceProof,
} from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Generate a proof for a direct payment, or resume a saved public proof with --resume.
if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to prove, submit and query Source recognition; add --resume to use a saved {sourceProof} record."
    );
    process.exit(0);
}

let sourceProof: ProvenanceProof;

if (process.argv.includes("--resume")) {
    // A saved proof needs neither openings, proving assets nor a new main transaction.
    const stored = (await readHostJson()) as { sourceProof: ProvenanceProof };
    sourceProof = stored.sourceProof;
} else {
    const provider = new JsonRpcProvider(settings.chainRpcUrl);
    try {
        if ((await provider.getNetwork()).chainId !== settings.chainId)
            throw Error("Primary chain mismatch");

        // 1. Connect to the verified deployment; reuse one prover for both proofs.
        const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
        const protocol = await Protocol.fromRpc(protocolRpc, provider);
        const [alice, bob] = getAccounts();
        const tokenAddress = settings.tokenAddress;
        const prover = new NativeProver({
            bbBin: settings.bbBin,
            threads: 4,
            ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
        });
        const invisi = new Invisi({
            provider,
            protocolRpc,
            prover,
        });

        // 2. Discover and decrypt inventory, then let Session select inputs and create change.
        // Use encrypted persistent storage in an App; this example keeps inventory in memory.
        const session = await WalletSession.connect({
            invisi,
            wallet: alice.publicWallet,
            protocol,
            store: new MemoryWalletStore(),
        });
        const pending = await session.refresh({
            fromBlock: protocol.deployment.protocol.fromBlock,
        });
        await pending.decrypt(decryptor);

        const balance = await session.balance(tokenAddress);
        if (balance.availableKnown === null || balance.availableKnown < 2n) {
            throw Error("Fund and recognize Alice's Notes first");
        }

        const output = await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: balance.availableKnown / 2n,
            recipient: { type: "invisi", address: bob.receivingAddress },
        });
        const prepared = await session.prepareTransfer({
            tokenAddress,
            outputs: [output],
        });

        // 3. Authorize the main payment; sending remains a separate host action.
        const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
        if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
            throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
        }

        const authorization = await prepared.exportWalletAuthorization();
        const signature = await signer.signTypedData(
            authorization.domain,
            authorization.types,
            authorization.message
        );
        const authorized = await prepared.withWalletSignature(signature);
        const ready = await authorized.prove();

        // 4. Generate the Source proof locally and retain it for later delivery.
        const provenance = new Provenance({ prover });
        sourceProof = await provenance.prove(ready);

        // Persist this public packet for --resume; keep any private backup encrypted.
        console.log("Save Provenance recovery packet:", json({ sourceProof }));
        console.log(
            "Transaction for independent host submission:",
            json(await ready.exportTransaction())
        );
    } finally {
        provider.destroy();
    }
}

// 5. The same submission handles preflight and later delivery; the service matches confirmations.
const provenance = new Provenance();
const accepted = await provenance.submit(sourceProof);
console.log("Provenance submission:", json(accepted));

const tracking = accepted.tracking as { id?: string; operationDigest?: string } | undefined;
if (!tracking?.id || tracking.operationDigest !== sourceProof.operationDigest)
    throw Error("Missing or mismatched Source tracking");

console.log("Save tracking ID:", tracking.id);

// 6. Observe recognition without recreating the main payment if the wait times out.
const source = await officialProvenanceClient(sourceProof.context);
// A wait timeout does not cancel the task; resume the saved packet to query again.
const result = await source.waitTracking(tracking.id, { timeoutMs: 120000, intervalMs: 2000 });
if (result.tracking.operationDigest !== sourceProof.operationDigest)
    throw Error("Source tracking operation changed");

console.log("Source recognition:", json(result));
