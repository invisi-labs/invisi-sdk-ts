import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { JsonRpcProvider, getBytes, toBeHex } from "ethers";
import { BroadcasterClient } from "@invisi-labs/sdk";
import {
    ProvenanceClient,
    authenticateManifest,
    exportSidecar,
    noteOpening,
    operationDigest,
    preflightTracking,
} from "@invisi-labs/sdk/provenance";
import type { Opening, RootCertificate, TrustContext } from "@invisi-labs/sdk/provenance";
import { LocalProvenanceProver } from "@invisi-labs/prover/provenance";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to prove/quote; add --submit to broadcast. See this directory's README."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.PROVENANCE_CONFIG!, "utf8"));
const pin = "f90f2ce43218de158c6392fa19e6517dda703c35823a4aa5bfc20b50788ad282";
const trust: TrustContext = {
    chainId: config.chainId,
    protocolAddress: config.protocolAddress,
    policyId: config.policyId,
    chainGeneration: config.generation,
    providerId: config.providerId,
    manifestSha256: pin,
    signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
};
const source = new ProvenanceClient(config.endpoint, trust);
await source.getVersion();

// The host retains the prepared main proof and its exact final fee-bearing statement.
// Read the opening locally; neither this input nor the witness is printed or sent over HTTP.
let local = "";
for await (const chunk of process.stdin) {
    if (local.length + chunk.length > 1 << 20)
        throw Error("Host-local input exceeds example limit");
    local += chunk;
}
let prepared: {
    rootId: string;
    tokenAddress: string;
    opening: Opening;
    mainCircuitCapacity: string;
    publicInputs: string[];
    data: string;
};
try {
    prepared = JSON.parse(local);
} catch {
    throw Error("Invalid host-local prepared JSON");
}
local = "";
const root = await source.getRoot(prepared.rootId);
if (root.allowedForNewProof !== true) throw Error("Root is not available for new proofs");
const certificate = root.certificate as RootCertificate;
const primary = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await primary.getNetwork()).chainId !== BigInt(config.chainId))
        throw Error("Primary chain mismatch");
    const anchor = await primary.getBlock(toBeHex(certificate.confirmedBlockNumber));
    if (!anchor || anchor.hash !== certificate.confirmedBlockHash)
        throw Error("Source checkpoint anchor is not canonical");
} finally {
    primary.destroy();
}
const tree = await source.syncRecognizedTree(prepared.rootId, certificate, { maxLeaves: 100000 });
const note = await noteOpening({
    ...trust,
    ...prepared.opening,
    tokenAddress: prepared.tokenAddress,
});
const membership = await tree.membershipForCommitment(trust, note.commitment);
if (!membership) throw Error("Input Note is not in this certified recognized prefix");
const main = prepared.publicInputs.map(BigInt),
    capacity = Number(prepared.mainCircuitCapacity);
if (
    main[0] !== BigInt(config.chainId) ||
    main[1] !== BigInt(config.protocolAddress) ||
    main[2] !== BigInt(prepared.tokenAddress) ||
    main[3] !== 1n ||
    main[6 + 2 * capacity] !== note.nullifier
)
    throw Error("Prepared main statement does not spend this exact one-input Note");
const digest = operationDigest({ ...trust, ...prepared });

const manifest = await readFile(join(config.assetRoot, "manifest.json"));
const identity = authenticateManifest(manifest, pin);
const prover = new LocalProvenanceProver({
    trustedManifestSha256: pin,
    threads: 4,
    ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
    loadAssets: async (capacity) => {
        const entry = (
            JSON.parse(manifest.toString()).circuits as {
                capacity: number;
                artifact: string;
                vk: string;
            }[]
        ).find((entry) => entry.capacity === capacity)!;
        return {
            manifest,
            artifact: await readFile(join(config.assetRoot, entry.artifact)),
            verificationKey: await readFile(join(config.assetRoot, entry.vk)),
        };
    },
});
// K1 means one private Note input, independently of the main circuit's total slots.
// exportSidecar builds the witness, proves locally and validates the returned statement.
const sidecar = await exportSidecar(
    {
        ...trust,
        capacity: 1,
        tokenAddress: prepared.tokenAddress,
        operationDigest: digest,
        inputs: [
            {
                ...prepared.opening,
                sourceIndex: 0,
                leafIndex: membership.leafIndex,
                path: membership.path,
            },
        ],
        sources: [
            {
                treeId: certificate.treeId,
                root: certificate.root,
                leafCount: certificate.leafCount,
            },
        ],
    },
    [certificate],
    trust,
    identity,
    prover,
    0
);

const evaluated = await source.evaluateTransaction(prepared.data, [sidecar]);
const tracking = preflightTracking(evaluated, "0", digest);
// The Broadcaster coalesces its own preflight with this same scoped operation task.
const broadcaster = new BroadcasterClient({
    ...config.broadcaster,
    provenancePolicyId: config.policyId,
});
// Fee discovery can run without sidecars BEFORE the host freezes/proves the main intent.
// Here data already includes that final fee; changing it requires fresh main/source proofs.
const quote = await broadcaster.quote(
    prepared.data,
    {
        chainId: BigInt(config.chainId),
        protocol: config.protocolAddress,
    },
    [sidecar]
);
const broadcastId = process.env.BROADCAST_ID!;
if (!/^[A-Za-z0-9_-]{1,63}$/.test(broadcastId ?? ""))
    throw Error("Set a stable BROADCAST_ID (1-63 characters)");
const record = {
    data: prepared.data,
    sidecar,
    broadcastId,
    quote,
    operationDigest: digest,
    trackingId: tracking.id,
};
// This record is public evidence only. Exclusive creation prevents overwriting an uncertain submission.
const file = await open(process.env.PROVENANCE_RECORD!, "wx", 0o600);
try {
    await file.writeFile(
        JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    );
    await file.sync();
} finally {
    await file.close();
}
console.log("Public sidecar and verified quote saved. Keep this record for confirmation/recovery.");
if (process.argv.includes("--submit")) {
    const status = await broadcaster.submit(prepared.data, quote, broadcastId, [sidecar]);
    console.log("Broadcaster status:", status);
    // An uncertain HTTP result is not a failed payment. Recover this ID; do not create another.
}
