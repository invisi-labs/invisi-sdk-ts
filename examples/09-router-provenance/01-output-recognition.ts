import { JsonRpcProvider } from "ethers";
import { settings } from "../settings.js";
import { Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { officialProvenanceClient } from "@invisi-labs/sdk/provenance";

if (!process.argv.includes("--execute")) {
    console.log("Review the trusted deployment settings, then pass --execute");
    process.exit(0);
}

const txHash = "REPLACE_WITH_CONFIRMED_ROUTER_TRANSACTION_HASH";
const noteCommitment = "REPLACE_WITH_NOTE_COMMITMENT_FROM_THIS_TRANSACTION";
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^0x[0-9a-fA-F]{64}$/.test(noteCommitment)) {
    throw new Error("Configure an actual transaction hash and its Note commitment");
}
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const provenanceClient = await officialProvenanceClient(protocol.context);

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
