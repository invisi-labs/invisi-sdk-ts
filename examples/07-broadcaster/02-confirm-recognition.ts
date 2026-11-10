import { JsonRpcProvider, getBytes } from "ethers";
import { ProvenanceClient, DEFAULT_PROVENANCE_ENDPOINT } from "@invisi-labs/sdk/provenance";
import { settings } from "../settings.js";
import { readHostJson } from "../host-transport.js";
import type { TrustContext, ProvenanceProof } from "@invisi-labs/sdk/provenance";

// Match these public trust pins to the deployment selected in ../settings.ts.
const provenanceEndpoint = DEFAULT_PROVENANCE_ENDPOINT;
const protocolAddress = "0x<20-byte-protocol-address>" as `0x${string}`;
const chainGeneration = "1";
const providerId = "0x<32-byte-provider-id>";
const signingKeyId = "0x<sha256-of-pinned-public-key>";
const signingPublicKey = "0x<32-byte-pinned-ed25519-public-key>";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute after host confirmation; set TRANSACTION_HASH and paste the logged broadcast record."
    );
    process.exit(0);
}
console.log("Paste the Broadcast record printed by example01.");
const record = (await readHostJson()) as {
    sourceProof: ProvenanceProof;
    submissionId: string;
};
const trust: TrustContext = {
    chainId: settings.chainId,
    protocolAddress,
    chainGeneration,
    providerId,
    manifestSha256: "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a",
    signingKeys: { [signingKeyId]: getBytes(signingPublicKey) },
};
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
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
        tx.to?.toLowerCase() !== protocolAddress.toLowerCase() ||
        tx.data.toLowerCase() !== record.sourceProof.data.toLowerCase()
    )
        throw Error("Canonical transaction mismatch");
    const source = new ProvenanceClient(provenanceEndpoint, trust);
    const locator = { txHash: hash, blockHash: receipt.blockHash, operationIndex: "0" };
    let operation = await source.getOperationRecognition(locator);
    const deadline = Date.now() + 120000;
    while (operation.recognitionState !== "recognized" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        operation = await source.getOperationRecognition(locator);
    }
    if (operation.recognitionState !== "recognized")
        throw Error("Source recognition pending; query the same operation later");
    console.log("Source service confirms operation recognition:", operation);
    // A recipient separately authenticates the published certificate and local membership.
} finally {
    provider.destroy();
}
