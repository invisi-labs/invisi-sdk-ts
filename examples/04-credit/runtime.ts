import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, ViewingCapability, type PreparedTransaction } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts, type Account } from "../accounts.js";
export async function runtime() {
    if (!process.argv.includes("--execute")) throw Error("Review the example, then pass --execute");
    const provider = new JsonRpcProvider(settings.chainRpcUrl);
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw Error("Configured chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl),
        protocol = await Protocol.fromRpc(protocolRpc, provider),
        invisi = new Invisi({ provider, protocolRpc, prover: new NativeProver({ bbBin: settings.bbBin }) });
    return { provider, protocolRpc, protocol, invisi, tokenAddress: settings.tokenAddress, accounts: getAccounts() };
}
export const viewer = (account: Account) =>
    new ViewingCapability(account.address, account.viewingPrivateKey, account.publicWallet.viewingPublicKey);
export async function proveAndSend(prepared: PreparedTransaction, signer: EthereumWallet) {
    const request = await prepared.exportWalletAuthorization(),
        signature = await signer.signTypedData(request.domain, request.types, request.message),
        ready = await (await prepared.withWalletSignature(signature)).prove(),
        transaction = await signer.sendTransaction(await ready.exportTransaction());
    console.log("Transaction:", transaction.hash);
    if ((await transaction.wait())?.status !== 1) throw Error("Settlement failed");
    return ready;
}
export { EthereumWallet };
