import { readFile } from "node:fs/promises";
import { JsonRpcProvider, getBytes } from "ethers";
import { ProvenanceClient, DEFAULT_PROVENANCE_ENDPOINT } from "@invisi-labs/sdk/provenance";
import { readHostJson } from "../host-transport.js";
import type { TrustContext } from "@invisi-labs/sdk/provenance";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute after host confirmation; set TRANSACTION_HASH and paste the logged broadcast record."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.EXAMPLE_CONFIG!, "utf8"));
console.log("Paste the Broadcast record printed by example01.");
const record = (await readHostJson()) as {
    data: string;
    submissionId: string;
    trackingId: string;
    operationDigest: string;
};
const trust: TrustContext = {
    chainId: config.chainId,
    protocolAddress: config.protocolAddress,
    chainGeneration: config.generation,
    providerId: config.providerId,
    manifestSha256: "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a",
    signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
};
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
    const source = new ProvenanceClient(config.endpoint ?? DEFAULT_PROVENANCE_ENDPOINT, trust);
    const locator = { txHash: hash, blockHash: receipt.blockHash, operationIndex: "0" };
    const tracked = await source.waitTracking(record.trackingId, {
        timeoutMs: 120000,
        intervalMs: 2000,
    });
    if (tracked.tracking.status !== "recognized")
        throw Error(
            `Tracking ${tracked.tracking.status}; retain the frozen transaction and record`
        );
    const matched = tracked.tracking.matched!;
    if (
        matched.txHash !== hash ||
        matched.blockHash !== receipt.blockHash ||
        matched.operationIndex !== "0" ||
        BigInt(tracked.tracking.operationDigest) !== BigInt(record.operationDigest)
    )
        throw Error("Tracking matched another operation");
    const operation = await source.getOperationRecognition(locator);
    if (operation.recognitionState !== "recognized")
        throw Error("Publication pending; retry the same tracking ID");
    console.log("Source service confirms operation recognition:", operation);
    // A recipient separately authenticates the published certificate and local membership.
} finally {
    provider.destroy();
}
