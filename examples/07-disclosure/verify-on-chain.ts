import { readFile } from "node:fs/promises";
import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Disclosure, DisclosureVerifier, Protocol } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Read-only verification. No wallet private key, proving backend, store or EVM signer is needed. */
export async function main(resources: ExampleResources) {
    console.log("1. Select a trusted deployment and bind the token for this disclosure");
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);

    const instance = protocol.forToken("0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const);

    console.log("2. Import explicitly supplied disclosure material without printing its contents");
    // This application document combines exported disclosure material with its actual chain reference.
    const { material, transactionHash, treeId, leafIndex } = JSON.parse(await readFile("./disclosure.json", "utf8"));
    const disclosure = await Disclosure.fromExport(material);
    console.log("Disclosure scope:", disclosure.getScope());
    // Use "owner" or "spender" when verifying a Credit role envelope.
    const role = "funds";

    console.log("3. Resolve the selected output from a successful receipt and matching insertion event");
    const verifier = new DisclosureVerifier({ protocol: instance, provider, confirmations: 1 });
    const verified = await verifier.verify(disclosure, {
        transactionHash,
        treeId: BigInt(treeId),
        leafIndex,
        role,
    });

    console.log("4. Check canonical block identity again after cryptographic verification");
    console.log("Verified output:", verified.output);
    console.log("Verified block:", verified.block.number, verified.block.hash);
    console.log("Confirmations:", verified.confirmations);
    console.log("Disclosed kind and amount:", verified.result.kind, verified.result.note.amount);
    // This establishes output content and inclusion at the returned block, not legal identity or spent state.
}
