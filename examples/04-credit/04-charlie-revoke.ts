import { runtime, EthereumWallet } from "./runtime.js";
// Owner-selected public grant reference; no latest private state or proof is required.
const h = await runtime();
try {
    const charlie = h.accounts[2]!,
        shardText = process.argv.find((value) => value.startsWith("--shard=")),
        slotText = process.argv.find((value) => value.startsWith("--slot="));
    if (!shardText || !slotText) throw Error("Supply the intended public grant reference with --shard=N --slot=N");
    const prepared = await h.invisi.prepareRevokeCredit({
            wallet: charlie.publicWallet,
            protocol: h.protocol,
            tokenAddress: h.tokenAddress,
            shard: BigInt(shardText.slice(8)),
            slot: BigInt(slotText.slice(7)),
            caller: charlie.address,
        }),
        ready = await prepared.ready(),
        transaction = await new EthereumWallet(charlie.privateKey, h.provider).sendTransaction(await ready.exportTransaction());
    console.log("Revocation transaction:", transaction.hash);
    await transaction.wait();
} finally {
    h.provider.destroy();
}
