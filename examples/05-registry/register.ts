import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { ProtocolRpcClient, Wallet, Invisi } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);

    console.log("1. Configure chain reads and Protocol RPC discovery on Invisi");
    const invisi = new Invisi({
        provider,
        protocolRpc,
    });

    console.log("2. Prepare register using the registry's own nonce, never the EVM funding nonce");
    const prepared = await invisi.prepareRegistration({
        wallet,
        update: false,
    });
    console.log("Local operation review:", prepared.preview());

    console.log("3. Sign the registry EIP-712 key snapshot with the owner; relay with ethers");
    const request = await prepared.exportRegistrationAuthorization();
    const ownerSigner = new EthereumWallet(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
    const ready = await prepared.withSignature(signature);
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    const tracked = ready.trackTransaction(transaction.hash);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt) throw new Error("Registry receipt is not available");
    const confirmed = await tracked.reconcile();
    if (confirmed.status !== "confirmed") throw new Error("Registry write needs reconciliation");
}
