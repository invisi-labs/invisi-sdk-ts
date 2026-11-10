import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonRpcProvider, Interface, getBytes, sha256, toUtf8Bytes, toQuantity } from "ethers";
import { Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { transactUserPublicInputs, selectTransactCapacity } from "@invisi-labs/protocol";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import {
    ProvenanceClient,
    DEFAULT_PROVENANCE_ENDPOINT,
    authenticateManifest,
    noteOpening,
    operationDigest,
    exportSidecar,
    word,
} from "@invisi-labs/sdk/provenance";
import type { TrustContext, RootCertificate } from "@invisi-labs/sdk/provenance";
import { LocalProvenanceProver } from "@invisi-labs/prover/provenance";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute with TRANSACTION_HASH to prove and submit provenance for a self-broadcast one-input transact."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.EXAMPLE_CONFIG!, "utf8"));
const pin = "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a";
const trust: TrustContext = {
    chainId: config.chainId,
    protocolAddress: config.protocolAddress,
    chainGeneration: config.generation,
    providerId: config.providerId,
    manifestSha256: pin,
    signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
};
const source = new ProvenanceClient(config.endpoint ?? DEFAULT_PROVENANCE_ENDPOINT, trust);
const manifest = await readFile(join(config.assetRoot, "manifest.json"));
const manifestIdentity = authenticateManifest(manifest, pin);
const sourceProver = new LocalProvenanceProver({
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

const provider = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId))
        throw Error("Primary chain mismatch");
    const hash = process.env.TRANSACTION_HASH!;
    const tx = await provider.getTransaction(hash),
        receipt = await provider.getTransactionReceipt(hash);
    if (
        !tx ||
        !receipt ||
        receipt.status !== 1 ||
        tx.to?.toLowerCase() !== config.protocolAddress.toLowerCase()
    )
        throw Error("Successful protocol transaction required");
    const block = await provider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash)
        throw Error("Transaction is not canonical");
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: tx.data });
    if (decoded?.name !== "transact") throw Error("This example supports a direct transact only");
    const raw = decoded.args[1];
    if (raw.params.nullifiers.length !== 1)
        throw Error(
            "Choose a transact with exactly one private Note input, including a pure withdrawal"
        );
    const context = {
        chainId: BigInt(config.chainId),
        protocolAddress: config.protocolAddress as `0x${string}`,
        tokenAddress: raw.params.token as `0x${string}`,
    };
    const protocolRpc = new ProtocolRpcClient(config.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (protocol.context.protocolAddress.toLowerCase() !== context.protocolAddress.toLowerCase())
        throw Error("Pinned deployment mismatch");
    const [alice] = getAccounts();
    // Include spent Notes: the host already sent the transaction independently.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        nativeWallet,
        tokenAddress: context.tokenAddress,
        includeSpent: true,
    });
    let selected: (typeof candidates)[number] | undefined;
    for (const input of candidates) {
        const opening = await noteOpening({
            ...context,
            owner: input.note.ownerAddress,
            nonce: input.note.nonce,
            amount: input.note.amount,
        });
        if (word(opening.nullifier) === word(raw.params.nullifiers[0])) {
            selected = input;
            break;
        }
    }
    if (!selected) throw Error("The local wallet cannot open this transaction's input Note");
    const status = await source.getStatus();
    const rootId = config.sourceRootId ?? `${trust.chainGeneration}:${status.checkpointSequence}`;
    const root = await source.getRoot(rootId);
    if (root.allowedForNewProof !== true) throw Error("Source root is not usable");
    const certificate = root.certificate as RootCertificate;
    const anchor = await provider.getBlock(toQuantity(BigInt(certificate.confirmedBlockNumber)));
    if (!anchor || anchor.hash !== word(certificate.confirmedBlockHash))
        throw Error("Source checkpoint is not canonical");
    const tree = await source.syncRecognizedTree(rootId, certificate, { maxLeaves: 100000 });
    const membership = await tree.membershipForCommitment(trust, selected.commitment);
    if (!membership)
        throw Error(
            "Input absent from this tree; set sourceRootId to a usable historical checkpoint containing it"
        );
    const params = {
        token: context.tokenAddress,
        sources: Array.from(raw.params.sources, (s: any) => ({
            treeId: s.treeId,
            merkleRoot: s.merkleRoot,
        })),
        nullifiers: [...raw.params.nullifiers],
        noteCommitments: [...raw.params.noteCommitments],
        withdrawalAddress: raw.params.withdrawalAddress,
        withdrawalAmount: raw.params.withdrawalAmount,
        deadline: raw.params.deadline,
        feeRecipient: raw.params.feeRecipient,
        feeAmount: raw.params.feeAmount,
    };
    const funding = {
        payer: raw.funding.payer,
        amount: raw.funding.amount,
        sigNonce: raw.funding.sigNonce,
        deadline: raw.funding.deadline,
        signature: raw.funding.signature,
        permit: {
            deadline: raw.funding.permit.deadline,
            v: Number(raw.funding.permit.v),
            r: raw.funding.permit.r,
            s: raw.funding.permit.s,
        },
    };
    const deliveries = Array.from(raw.deliveries, (d: any) => ({
        ciphertext: d.ciphertext,
        clue: d.clue,
    }));
    const capacity = selectTransactCapacity(
        params.nullifiers.length,
        params.noteCommitments.length
    );
    const digest = operationDigest({
        ...context,
        mainCircuitCapacity: capacity,
        publicInputs: transactUserPublicInputs(context, params, deliveries, funding),
    });
    const sidecar = await exportSidecar(
        {
            ...trust,
            capacity: 1,
            tokenAddress: context.tokenAddress,
            operationDigest: digest,
            inputs: [
                {
                    owner: selected.note.ownerAddress,
                    nonce: selected.note.nonce,
                    amount: selected.note.amount,
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
        manifestIdentity,
        sourceProver,
        0
    );
    console.log("Local source proof verified; no Broadcaster is used.");
    const locator = { txHash: hash, blockHash: receipt.blockHash, operationIndex: "0" };
    const idempotencyKey = `${hash.slice(2, 18)}:${sha256(toUtf8Bytes(json(sidecar.proofBundle))).slice(2)}`;
    console.log(
        "Provenance submission:",
        json({ locator, proofBundle: sidecar.proofBundle, idempotencyKey })
    );
    // Retry a lost response with this exact saved bundle/key, not a newly generated proof.
    const submitted = await source.submitProof(locator, sidecar.proofBundle, idempotencyKey);
    if (typeof submitted.jobId !== "string" || !submitted.jobId)
        throw Error("Missing source proof job ID; retain the saved record");
    const job = await source.waitProofJob(submitted.jobId);
    if (job.status !== "valid") throw Error(`Source proof job: ${job.status}`);
    console.log("Source verification:", json(job));
    console.log(
        "Current operation recognition:",
        json(await source.getOperationRecognition(locator))
    );
} finally {
    provider.destroy();
}
