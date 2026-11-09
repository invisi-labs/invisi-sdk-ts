import type { Provider } from "ethers";
import {
    DisclosureVerifier,
    computeCreditNullifier,
    type CreditInput,
    type Protocol,
    type ProtocolRpcClient,
    type PublicWallet,
    type ViewingCapability,
    type IndexedCreditState,
} from "@invisi-labs/sdk";
/** Discover indexed public state leaves; canonical decryption/receipt checks remain separate. */
export async function discoverIndexedCreditStates(
    protocolRpc: ProtocolRpcClient,
    protocol: Protocol,
    provider: Provider
): Promise<IndexedCreditState[]> {
    const rpc = protocolRpc.withProvider(provider),
        status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) throw Error("Protocol RPC has no indexed head");
    const hashes = new Set<`0x${string}`>();
    for (let fromBlock = protocol.deployment.protocol.fromBlock; fromBlock <= status.indexedHead.number; fromBlock += 100n) {
        const toBlock = fromBlock + 99n < status.indexedHead.number ? fromBlock + 99n : status.indexedHead.number,
            page = await rpc.getCreditTransitions(protocol.context, { fromBlock, toBlock });
        for (const event of page.transitions) hashes.add(event.transactionHash);
    }
    const states = new Map<`0x${string}`, IndexedCreditState>();
    for (const hash of hashes) {
        const result = await rpc.getTransactionCreditUpdates(protocol.context, hash);
        if (result.status === "indexed") for (const state of result.states) states.set(state.commitment, state);
    }
    return [...states.values()];
}
/** Select a role after authenticated decryption; never infer it from an FMD candidate. */
export async function discoverCredits({
    provider,
    protocolRpc,
    protocol,
    wallet,
    viewer,
    tokenAddress,
    role,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: PublicWallet;
    viewer: ViewingCapability;
    tokenAddress: `0x${string}`;
    role: "owner" | "spender";
}): Promise<CreditInput[]> {
    if (wallet.ownerAddress !== viewer.ownerAddress) throw Error("Viewing and public wallet identities differ");
    const rpc = protocolRpc.withProvider(provider),
        status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) throw Error("Protocol RPC has no indexed head");
    const verifier = new DisclosureVerifier({ protocol: protocol.forToken(tokenAddress), provider, confirmations: 1 }),
        result: CreditInput[] = [];
    for (const indexed of await discoverIndexedCreditStates(protocolRpc, protocol, provider)) {
        if (BigInt(indexed.tokenAddress) !== BigInt(tokenAddress)) continue;
        const delivery = indexed.deliveries[role === "owner" ? 0 : 1];
        let state;
        try {
            state = await viewer.decryptCredit(delivery.ciphertext, {
                chainId: protocol.context.chainId,
                protocolAddress: BigInt(protocol.context.protocolAddress),
                tokenAddress: BigInt(tokenAddress),
                outputCommitment: indexed.commitment,
                role,
            });
        } catch {
            continue;
        }
        const nullifier = await computeCreditNullifier(state.note.chainId, state.note.creditSharedKey, indexed.commitment);
        if (await rpc.isCreditConsumed(protocol.context, nullifier, status.indexedHead)) continue;
        const bitmap = await rpc.getCreditRevocationBitmap(
            protocol.context,
            state.note.ownerWalletIdentity,
            tokenAddress,
            state.note.revocationShard,
            Number(state.note.revocationSlot >> 8n),
            status.indexedHead
        );
        if (bitmap.bitmap & (1n << (state.note.revocationSlot & 255n))) continue;
        const evidence = await verifier.readOutput({
            transactionHash: indexed.transactionHash,
            treeId: indexed.treeId,
            leafIndex: indexed.leafIndex,
            role,
        });
        if (
            evidence.output.outputCommitment !== indexed.commitment ||
            evidence.output.ciphertext !== delivery.ciphertext ||
            evidence.block.hash !== indexed.block.hash
        )
            throw Error("Indexed Credit differs from canonical receipt");
        result.push({ state, commitment: indexed.commitment, treeId: indexed.treeId, leafIndex: indexed.leafIndex, role });
    }
    return result;
}
