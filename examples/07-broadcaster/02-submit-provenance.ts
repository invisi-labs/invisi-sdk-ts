import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import {
    Provenance,
    officialProvenanceClient,
    type ProvenanceProof,
} from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";
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
        const candidates = await discoverCandidates({
            provider,
            protocolRpc,
            protocol,
            wallet: alice.publicWallet,
            decryptor,
            tokenAddress,
        });
        const input = candidates.find((note) => note.note.amount > 1n);
        if (!input) throw Error("Fund and recognize Alice's Note first");
        const output = await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: input.note.amount / 2n,
            recipient: { type: "invisi", address: bob.receivingAddress },
        });
        const prepared = await invisi.prepareTransfer({
            wallet: alice.publicWallet,
            protocol,
            tokenAddress,
            inputs: [input],
            outputs: [output],
        });
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
        const ready = await (await prepared.withWalletSignature(signature)).prove();
        const provenance = new Provenance({ prover });
        sourceProof = await provenance.prove(ready);
        // The App must persist this public proof packet before sending; do not save any witness/opening in public history.
        console.log("Save Provenance recovery packet:", json({ sourceProof }));
        console.log(
            "Transaction for independent host submission:",
            json(await ready.exportTransaction())
        );
    } finally {
        provider.destroy();
    }
}

// Pre-submission and later delivery use the same call; the service matches canonical confirmations.
const provenance = new Provenance();
const accepted = await provenance.submit(sourceProof);
console.log("Provenance submission:", json(accepted));
const tracking = accepted.tracking as { id?: string; operationDigest?: string } | undefined;
if (!tracking?.id || tracking.operationDigest !== sourceProof.operationDigest)
    throw Error("Missing or mismatched Source tracking");
console.log("Save tracking ID:", tracking.id);
const source = await officialProvenanceClient(sourceProof.context);
const result = await source.waitTracking(tracking.id, { timeoutMs: 120000, intervalMs: 2000 });
if (result.tracking.operationDigest !== sourceProof.operationDigest)
    throw Error("Source tracking operation changed");
console.log("Source recognition:", json(result));
// A wait timeout does not cancel delivery. Resume the saved record instead of recreating payment.
