import { readFile } from "node:fs/promises";
import { JsonRpcProvider, getBytes } from "ethers";
import { ProvenanceClient, validateProofBundle } from "@invisi-labs/sdk/provenance";
import type { TrustContext, ProofSidecar } from "@invisi-labs/sdk/provenance";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute after host confirmation; set TRANSACTION_HASH and retain the public record."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.PROVENANCE_CONFIG!, "utf8"));
const record = JSON.parse(await readFile(process.env.PROVENANCE_RECORD!, "utf8")) as {
    data: string;
    sidecar: ProofSidecar;
    broadcastId: string;
};
const trust: TrustContext = {
    chainId: config.chainId,
    protocolAddress: config.protocolAddress,
    policyId: config.policyId,
    chainGeneration: config.generation,
    providerId: config.providerId,
    manifestSha256: "f90f2ce43218de158c6392fa19e6517dda703c35823a4aa5bfc20b50788ad282",
    signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
};
await validateProofBundle(record.sidecar.proofBundle, trust);
const provider = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId))
        throw Error("Primary chain mismatch");
    const hash = process.env.TRANSACTION_HASH!;
    const receipt = await provider.getTransactionReceipt(hash);
    const tx = await provider.getTransaction(hash);
    if (!receipt || !tx || receipt.status !== 1)
        throw Error("Successful receipt not yet available");
    const block = await provider.getBlock(receipt.blockNumber);
    if (
        !block ||
        block.hash !== receipt.blockHash ||
        tx.blockHash !== receipt.blockHash ||
        tx.to?.toLowerCase() !== config.protocolAddress.toLowerCase() ||
        tx.data.toLowerCase() !== record.data.toLowerCase()
    )
        throw Error("Canonical transaction mismatch");
    const source = new ProvenanceClient(config.endpoint, trust);
    const locator = { txHash: hash, blockHash: receipt.blockHash, operationIndex: "0" };
    const submitted = await source.submitProof(
        locator,
        record.sidecar.proofBundle,
        `${record.broadcastId}-source`
    );
    const job = await source.waitProofJob(String(submitted.jobId));
    if (job.status !== "valid")
        throw Error(`Source proof job: ${job.status}; retain the original transaction/record`);
    // A valid proof job precedes publication. Do not mark the output recognized yet.
    for (let attempt = 0; attempt < 60; attempt++) {
        const operation = await source.getOperationRecognition(locator);
        if (operation.recognitionState === "recognized") {
            console.log("Source service confirms operation recognition:", operation);
            break;
        }
        if (attempt === 59)
            throw Error("Publication pending; rerun with the same transaction and record");
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // A recipient separately authenticates the published certificate and local membership.
} finally {
    provider.destroy();
}
