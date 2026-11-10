import { authenticatedDecryptor, type DeliveryDecryptor } from "@invisi-labs/core";
import type { WalletSessionInfrastructure } from "../operations/operation-types";
import {
    walletBalances,
    type WalletScope,
    type WalletState,
    type WalletStore,
} from "../storage/state";
import { WalletUpdater, type CandidatePage, type ApplyPageOptions } from "./WalletUpdater";
import { refreshWallet, type RefreshOptions, type RefreshResult } from "./refresh";

export interface PendingWalletRefresh {
    readonly block: RefreshResult["block"];
    decrypt(decryptor: DeliveryDecryptor): Promise<RefreshResult>;
}
function memoryStore(initial: WalletState) {
    let state = structuredClone(initial);
    const store: WalletStore = {
        persistent: false,
        readSnapshot: async () => structuredClone(state),
        transaction: async (_scope, action) => {
            const draft = structuredClone(state);
            const result = action(draft);
            draft.revision = state.revision + 1;
            state = draft;
            return result;
        },
    };
    return { store, snapshot: () => structuredClone(state) };
}

/** Stage canonical candidates without host cryptography or managed state writes. */
export async function prepareWalletRefresh(
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    settings: RefreshOptions
): Promise<PendingWalletRefresh> {
    const store = options.store!;
    const base = await store.readSnapshot(scope);
    let active: ReturnType<typeof authenticatedDecryptor> | undefined;
    const viewing = {
        ownerAddress: options.wallet.ownerAddress,
        async decryptNote(
            ...args: Parameters<ReturnType<typeof authenticatedDecryptor>["decryptNote"]>
        ) {
            if (!active) return null;
            return active.decryptNote(...args);
        },
        async decryptCredit(
            ...args: Parameters<ReturnType<typeof authenticatedDecryptor>["decryptCredit"]>
        ) {
            if (!active) return null;
            return active.decryptCredit(...args);
        },
    };
    const receiving = options.wallet.getReceivingAddress();
    const updater = (target: WalletStore) =>
        new WalletUpdater({
            protocol: options.protocol,
            scope,
            store: target,
            reader: options.chainReader!,
            protocolRpc: options.protocolRpc!,
            viewing,
            ...(receiving.kind === "long" ? { receivingKeys: receiving.getReceivingKeys() } : {}),
        });
    const preview = memoryStore(base);
    const collector = updater(preview.store);
    const pages: Array<{ batch: CandidatePage; settings: ApplyPageOptions }> = [];
    const result = await refreshWallet(
        {
            provider: options.protocolRpc!,
            reader: options.chainReader!,
            context: options.protocol.context,
            fromBlock: options.protocol.deployment.protocol.fromBlock,
            apply: async (batch, pageSettings) => {
                pages.push({ batch: structuredClone(batch), settings: { ...pageSettings } });
                return collector.applyUpdates(batch, pageSettings);
            },
        },
        settings
    );
    let state: "pending" | "applying" | "applied" = "pending";
    return {
        block: structuredClone(result.block),
        async decrypt(decryptor) {
            if (state !== "pending") throw new Error("wallet refresh already applying or applied");
            state = "applying";
            try {
                settings.signal?.throwIfAborted();
                if ((await store.readSnapshot(scope)).revision !== base.revision)
                    throw new Error("wallet changed during refresh; prepare again");
                active = authenticatedDecryptor(options.wallet, decryptor);
                const final = memoryStore(base);
                const processor = updater(final.store);
                let notes = 0,
                    credits = 0;
                for (const page of pages) {
                    const appliedPage = await processor.applyUpdates(page.batch, page.settings);
                    notes += appliedPage.notes;
                    credits += appliedPage.credits;
                }
                const finalState = final.snapshot();
                const previous = finalState.discoveryThrough;
                const start = previous
                    ? previous.number + 1n
                    : options.protocol.deployment.protocol.fromBlock;
                if (
                    settings.fromBlock <= start &&
                    (!previous || result.block.number >= previous.number)
                )
                    finalState.discoveryThrough = {
                        number: result.block.number,
                        hash: result.block.hash,
                    };
                settings.signal?.throwIfAborted();
                await store.transaction(scope, (draft) => {
                    if (draft.revision !== base.revision)
                        throw new Error("wallet changed during refresh; prepare again");
                    for (const name of [
                        "observedThrough",
                        "discoveryThrough",
                        "invalidated",
                    ] as const)
                        delete draft[name];
                    Object.assign(draft, finalState, { revision: draft.revision });
                });
                state = "applied";
                active = undefined;
                return {
                    block: structuredClone(result.block),
                    notes,
                    credits,
                    balances: walletBalances(await store.readSnapshot(scope)),
                };
            } catch (error) {
                active = undefined;
                state = "pending";
                throw error;
            }
        },
    };
}
