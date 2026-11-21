import { JsonRpcProvider, getBytes } from "ethers";
import { settings } from "../settings.js";
import { Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { ProvenanceClient, type TrustContext } from "@invisi-labs/sdk/provenance";

if (!process.argv.includes("--execute")) {
    console.log("Review the trusted deployment settings, then pass --execute");
    process.exit(0);
}

// Pin Source scope and signing identity independently from the service being queried.
const provenanceEndpoint = "REPLACE_WITH_REVIEWED_PROVENANCE_ENDPOINT";
const protocolAddress = "REPLACE_WITH_DEPLOYED_PROTOCOL_ADDRESS";
const chainGeneration = "REPLACE_WITH_CHAIN_GENERATION";
const providerId = "REPLACE_WITH_PROVIDER_ID";
const signingKeyId = "REPLACE_WITH_SIGNING_KEY_ID";
const signingPublicKey = "REPLACE_WITH_ED25519_PUBLIC_KEY";
const manifestSha256 = "REPLACE_WITH_MANIFEST_SHA256";
const txHash = "REPLACE_WITH_CONFIRMED_ROUTER_TRANSACTION_HASH";
const noteCommitment = "REPLACE_WITH_NOTE_COMMITMENT_FROM_THIS_TRANSACTION";
if (
    !/^https:\/\//.test(provenanceEndpoint) ||
    !/^0x[0-9a-fA-F]{40}$/.test(protocolAddress) ||
    !/^[1-9][0-9]*$/.test(chainGeneration) ||
    !/^0x[0-9a-fA-F]{64}$/.test(providerId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signingKeyId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signingPublicKey) ||
    !/^[0-9a-fA-F]{64}$/.test(manifestSha256) ||
    !/^0x[0-9a-fA-F]{64}$/.test(txHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(noteCommitment)
) {
    throw new Error("Configure verified deployment trust and actual transaction references");
}
const trust: TrustContext = {
    chainId: settings.chainId,
    protocolAddress,
    chainGeneration,
    providerId,
    signingKeys: {
        [signingKeyId]: getBytes(signingPublicKey),
    },
    manifestSha256,
};
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (BigInt(protocol.context.protocolAddress) !== BigInt(protocolAddress)) {
        throw new Error("Protocol RPC deployment does not match the pinned Provenance scope");
    }
    const provenanceClient = new ProvenanceClient(provenanceEndpoint, trust);

    // Querying a public commitment reveals interest; no viewing keys or openings are sent.
    console.log(
        "Transaction recognition:",
        await provenanceClient.getTransactionRecognition(txHash)
    );
    console.log("Note recognition:", await provenanceClient.getNoteRecognition(noteCommitment));
    // Preserve pending states and reasons. A successful receipt alone does not imply recognition.
} finally {
    provider.destroy();
}
