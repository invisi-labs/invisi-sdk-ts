import { readFile } from "node:fs/promises";
import { JsonRpcProvider } from "ethers";
import { Protocol } from "@invisi-labs/sdk";
import { defineDeployment } from "@invisi-labs/rpc";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Pin an independently published team deployment instead of discovering its identity through RPC. */
export async function main(resources: ExampleResources) {
    console.log("1. Load the deployment record published by a trusted team");
    const record: unknown = JSON.parse(await readFile(required("INVISI_DEPLOYMENT_FILE"), "utf8"));
    // The record supplies chainId, protocol { address, runtimeCodeHash, fromBlock },
    // plus optional registry metadata. Token support comes from the Protocol, not this file.
    const deployment = defineDeployment(record);
    const protocol = new Protocol({ deployment });

    console.log("2. Connect an explicitly selected RPC and authenticate the deployment");
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    await protocol.validateDeployment(provider);

    console.log("Protocol address:", protocol.context.protocolAddress);
    console.log("Chain ID:", protocol.context.chainId.toString());
    console.log("Scan from block:", deployment.protocol.fromBlock.toString());
    // Pass this deployment to ProtocolRpcClient options to require matching service pins.
}
