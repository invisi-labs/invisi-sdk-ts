import type { Provider } from "ethers";
import {
    DisclosureVerifier,
    computeCreditNullifier,
    type CreditInput,
    type Protocol,
    type ProtocolRpcClient,
    type Wallet,
    type DisclosureReference,
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
    if (!status.indexedHead) {
        throw Error("Protocol RPC has no indexed head");
    }
    const hashes = new Set<`0x${string}`>();
    for (
        let fromBlock = protocol.deployment.protocol.fromBlock;
        fromBlock <= status.indexedHead.number;
        fromBlock += 100n
    ) {
        const toBlock =
                fromBlock + 99n < status.indexedHead.number
                    ? fromBlock + 99n
                    : status.indexedHead.number,
            page = await rpc.getCreditTransitions(protocol.context, { fromBlock, toBlock });
        for (const event of page.transitions) hashes.add(event.transactionHash);
    }
    const states = new Map<`0x${string}`, IndexedCreditState>();
    const positions = new Map<string, string>();
    for (const hash of hashes) {
        const result = await rpc.getTransactionCreditUpdates(protocol.context, hash);
        if (result.status === "indexed") {
            for (const state of result.states) {
                const fingerprint = JSON.stringify(state, (_, value) =>
                    typeof value === "bigint" ? value.toString() : value
                );
                const existing = states.get(state.commitment),
                    position = `${state.treeId}:${state.leafIndex}`;
                const previousPosition = positions.get(position);
                if (
                    (existing &&
                        JSON.stringify(existing, (_, value) =>
                            typeof value === "bigint" ? value.toString() : value
                        ) !== fingerprint) ||
                    (previousPosition !== undefined && previousPosition !== fingerprint)
                ) {
                    throw Error("Conflicting Credit contents or positions");
                }
                positions.set(position, fingerprint);
                states.set(state.commitment, state);
            }
        }
    }
    return [...states.values()];
}
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import {
    prepareWalletRequest,
    acceptWalletResponse,
    NativeWalletError,
    type NativeWalletClient,
    type WalletResponse,
} from "@invisi-labs/core";
/** Recover current role-scoped states without an application-owned viewing key. */
export async function discoverCredits({
    provider,
    protocolRpc,
    protocol,
    wallet,
    nativeWallet,
    tokenAddress,
    role,
    includeConsumed = false,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: Wallet;
    nativeWallet: NativeWalletClient;
    tokenAddress: `0x${string}`;
    role: "owner" | "spender";
    includeConsumed?: boolean;
}): Promise<
    (CreditInput & {
        reference: DisclosureReference;
    })[]
> {
    const rpc = protocolRpc.withProvider(provider),
        status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) {
        throw Error("Protocol RPC has no indexed head");
    }
    const verifier = new DisclosureVerifier({
        protocol: protocol.forToken(tokenAddress),
        reader: new EthersChainReader(provider),
        confirmations: 1,
    });
    const result: (CreditInput & {
        reference: DisclosureReference;
    })[] = [];
    const states = (await discoverIndexedCreditStates(protocolRpc, protocol, provider)).filter(
        (indexed) => BigInt(indexed.tokenAddress) === BigInt(tokenAddress)
    );
    // Batch only role-scoped decryptions for this owner; malformed responses abort discovery.
    for (let offset = 0; offset < states.length; offset += 1024) {
        const batch = states.slice(offset, offset + 1024);
        const prepared = batch.map((indexed) =>
            prepareWalletRequest(wallet, crypto.randomUUID(), "wallet.decryptCredit", {
                envelope: indexed.deliveries[role === "owner" ? 0 : 1].ciphertext,
                context: {
                    chainId: protocol.context.chainId.toString(),
                    protocolAddress: BigInt(protocol.context.protocolAddress).toString(),
                    tokenAddress: BigInt(tokenAddress).toString(),
                    outputCommitment: indexed.commitment,
                    role,
                },
            })
        );
        const responses = await nativeWallet.execute(prepared.map((item) => item.request));
        for (let index = 0; index < prepared.length; index++) {
            const request = prepared[index]!,
                indexed = batch[index]!;
            const response = responses.find((item) => item.id === request.request.id);
            if (!response) {
                throw Error("Missing native Credit response");
            }
            let state;
            try {
                state = await acceptWalletResponse(
                    request,
                    response as WalletResponse<"wallet.decryptCredit">
                );
            } catch (error) {
                // A generic native failure must never be treated as an unrelated recipient.
                if (error instanceof NativeWalletError && error.code === "WALLET_NOT_RECIPIENT") {
                    continue;
                }
                throw error;
            }
            const reference: DisclosureReference = {
                transactionHash: indexed.transactionHash,
                treeId: indexed.treeId,
                leafIndex: indexed.leafIndex,
                role,
            };
            const evidence = await verifier.readOutput(reference);
            if (
                evidence.output.outputCommitment !== indexed.commitment ||
                evidence.output.ciphertext !==
                    indexed.deliveries[role === "owner" ? 0 : 1].ciphertext ||
                evidence.block.hash !== indexed.block.hash
            ) {
                throw Error("Indexed Credit differs from canonical receipt");
            }
            if (!includeConsumed) {
                const nullifier = await computeCreditNullifier(
                    state.note.chainId,
                    state.note.creditSharedKey,
                    indexed.commitment
                );
                if (await rpc.isCreditConsumed(protocol.context, nullifier, status.indexedHead)) {
                    continue;
                }
                const bitmap = await rpc.getCreditRevocationBitmap(
                    protocol.context,
                    state.note.ownerWalletIdentity,
                    tokenAddress,
                    state.note.revocationShard,
                    Number(state.note.revocationSlot >> 8n),
                    status.indexedHead
                );
                if (bitmap.bitmap & (1n << (state.note.revocationSlot & 255n))) {
                    continue;
                }
            }
            result.push({
                state,
                commitment: indexed.commitment,
                treeId: indexed.treeId,
                leafIndex: indexed.leafIndex,
                role,
                reference,
            });
        }
    }
    return result;
}
