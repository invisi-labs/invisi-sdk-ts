import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { ProtocolRpcClient, Wallet, AddressRegistry } from "@invisi-labs/sdk";
import { EthersAddressResolver } from "@invisi-labs/sdk/ethers";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const deployment = await protocolRpc.getDeployment((await provider.getNetwork()).chainId);
    if (!deployment.registry) throw new Error("The selected deployment has no receiving-key registry");

    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);

    console.log("1. Select a registry deployment and its trusted runtime profile, independently from the funds protocol");
    const context = {
        chainId: deployment.chainId,
        registryAddress: deployment.registry.address,
    };
    const hash = deployment.registry.runtimeCodeHash;
    const lookup = new EthersAddressResolver(provider, context, hash);
    const registry = new AddressRegistry(context, {
        lookup: lookup.lookup,
        expectedRuntimeCodeHash: hash,
    });

    console.log("2. Prepare update using the registry's own nonce, never the EVM funding nonce");
    const prepared = await registry.prepareRegistration({
        wallet,
        provider,
        signer: new EthereumWallet(required("WALLET_ACCOUNT_PRIVATE_KEY")),
        update: true,
    });
    console.log("Local operation review:", prepared.preview());

    console.log("3. Sign the registry EIP-712 key snapshot with the owner; relay with ethers");
    const ready = await prepared.authorize();
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    const tracked = ready.trackTransaction(transaction.hash);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt) throw new Error("Registry receipt is not available");
    const confirmed = await tracked.reconcile();
    if (confirmed.status !== "confirmed") throw new Error("Registry write needs reconciliation");
}
