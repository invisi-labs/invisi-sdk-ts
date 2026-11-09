import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";

if (!process.argv.includes("--execute")) throw Error("Review the example, then pass --execute");
const shardText = process.argv.find((value) => value.startsWith("--shard="));
const slotText = process.argv.find((value) => value.startsWith("--slot="));
if (!shardText || !slotText) throw Error("Supply the intended public grant reference with --shard=N --slot=N");

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw Error("Configured chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const invisi = new Invisi({ provider, protocolRpc });
    const charlie = getAccounts()[2]!;
    const signer = new EthereumWallet(charlie.privateKey, provider);

    // Owner submission needs no latest private state, separate revocation signature or ZK proof.
    const prepared = await invisi.prepareRevokeCredit({
        wallet: charlie.publicWallet,
        protocol,
        tokenAddress: settings.tokenAddress,
        shard: BigInt(shardText.slice(8)),
        slot: BigInt(slotText.slice(7)),
        caller: charlie.address,
    });
    const ready = await prepared.ready();
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Revocation transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (receipt?.status !== 1) throw Error("Credit revocation failed");
} finally {
    provider.destroy();
}
