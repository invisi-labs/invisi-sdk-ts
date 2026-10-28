import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Protocol, Wallet } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Connect trusted RPC services without opening storage or creating a wallet session. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    console.log("1. Load the deployment and validate its chain, version and runtime bytecode");
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));

    console.log("2. Shared infrastructure is ready; select this wallet and Protocol per operation");
    console.log("Chain:", protocol.context.chainId);
    console.log("Protocol:", protocol.context.protocolAddress);
    console.log("Receiving address:", wallet.getAddress());
    // Pass wallet, protocol and application-selected inputs to invisi.prepareTransfer(...).
    // Add a prover when preparing private spends. See 03-funds and 08-wallet-session.
}
