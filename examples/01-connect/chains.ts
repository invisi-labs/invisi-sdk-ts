import { JsonRpcProvider } from "ethers";
import { Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Discover supported chains and inspect the selected service without wallet permissions. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    console.log("1. Discover the chains supported by the selected Protocol RPC service");
    const chains = await ProtocolRpcClient.getChains(required("PROTOCOL_RPC_URL"));
    console.log(
        "Supported chain IDs:",
        chains.map((chain) => chain.chainId.toString())
    );
    const chainId = (await provider.getNetwork()).chainId;
    const selected = chains.find((chain) => chain.chainId === chainId);
    if (!selected) throw new Error("The selected Protocol RPC service does not support this chain");

    const protocolRpc = new ProtocolRpcClient(selected.rpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);

    console.log("2. Inspect the indexer's declared head and detection policy");
    const status = await protocolRpc.withProvider(provider).getStatus(protocol.context);
    console.log("Indexed head:", status.indexedHead?.number ?? "unknown");
    console.log("Detection enabled:", status.detectionEnabled, "checked bits:", status.checkedBits);

    console.log("3. Keep decryption, wallet state, authorization and proving in the client");
    // The server indexes events and supplies candidate references and membership paths.
    // No viewing, authorization or proving keys are sent to this service.
    // A declared indexed head cannot establish complete wallet history.
}
