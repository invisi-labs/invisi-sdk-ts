import { hexlify } from "ethers";
import {
    acceptWalletResponse,
    validateWalletResponses,
    validateWalletBatch,
    NativeWalletError,
    prepareWalletRequest,
    type PreparedWalletRequest,
    type WalletRequest,
    type WalletResponse,
    type WalletMethod,
    type WalletParams,
    type ViewingCapability,
    type WalletAcceptedResults,
    type NoteDecryptionContext,
    type CreditStateDecryptionContext,
} from "@invisi-labs/core";
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
    readonly walletRequests: readonly WalletRequest[];
    applyWalletResponses(responses: readonly WalletResponse[]): Promise<RefreshResult>;
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
    const prepared = new Map<string, PreparedWalletRequest>();
    const decoded = new Map<string, unknown>();
    let collecting = true;
    let unexpected = false;
    const request = async <M extends WalletMethod>(
        method: M,
        params: WalletParams[M]
    ): Promise<WalletAcceptedResults[M]> => {
        const key = JSON.stringify({ method, params });
        if (collecting && !prepared.has(key))
            prepared.set(
                key,
                prepareWalletRequest(options.wallet, crypto.randomUUID(), method, params)
            );
        if (!collecting && !prepared.has(key)) unexpected = true;
        if (!decoded.has(key) || decoded.get(key) === null)
            throw new Error("delivery has no accepted wallet response");
        return decoded.get(key) as WalletAcceptedResults[M];
    };
    const context = (
        value:
            | Omit<NoteDecryptionContext, "ownerAddress">
            | Omit<CreditStateDecryptionContext, "ownerAddress">
    ) => ({
        chainId: value.chainId.toString(),
        protocolAddress: BigInt(value.protocolAddress).toString(),
        tokenAddress: value.tokenAddress.toString(),
        outputCommitment: value.outputCommitment,
        ...("role" in value ? { role: value.role } : {}),
    });
    const viewing: Pick<ViewingCapability, "ownerAddress" | "decryptNote" | "decryptCredit"> = {
        ownerAddress: options.wallet.ownerAddress,
        decryptNote: (envelope, value) =>
            request("wallet.decryptNote", {
                envelope: hexlify(envelope) as `0x${string}`,
                context: context(value),
            }),
        decryptCredit: (envelope, value) =>
            request("wallet.decryptCredit", {
                envelope: hexlify(envelope) as `0x${string}`,
                context: context(value),
            }),
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
    collecting = false;
    let state: "pending" | "applying" | "applied" = "pending";
    const walletRequests = [...prepared.values()].map((value) => structuredClone(value.request));
    try {
        validateWalletBatch(walletRequests);
    } catch {
        throw new Error("refresh exceeds native wallet batch limits; use a smaller block range");
    }
    return {
        block: structuredClone(result.block),
        walletRequests,
        async applyWalletResponses(responses) {
            if (state !== "pending") throw new Error("wallet refresh already applying or applied");
            state = "applying";
            try {
                settings.signal?.throwIfAborted();
                if ((await store.readSnapshot(scope)).revision !== base.revision)
                    throw new Error("wallet changed during refresh; prepare again");
                const retained = [...prepared.values()];
                const ordered = validateWalletResponses(
                    retained.map((value) => value.request),
                    responses
                );
                decoded.clear();
                for (const [index, [key, request]] of [...prepared.entries()].entries()) {
                    const response = ordered[index]!;
                    if ("error" in response && response.error) {
                        if (
                            response.error.code !== "WALLET_NOT_RECIPIENT" ||
                            (request.request.method !== "wallet.decryptNote" &&
                                request.request.method !== "wallet.decryptCredit")
                        ) {
                            throw new NativeWalletError(response.error.code);
                        }
                        decoded.set(key, null);
                    } else {
                        decoded.set(key, await acceptWalletResponse(request, response));
                    }
                }
                const final = memoryStore(base);
                const processor = updater(final.store);
                let notes = 0,
                    credits = 0;
                for (const page of pages) {
                    const appliedPage = await processor.applyUpdates(page.batch, page.settings);
                    notes += appliedPage.notes;
                    credits += appliedPage.credits;
                }
                if (unexpected)
                    throw new Error("canonical deliveries changed; prepare refresh again");
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
                decoded.clear();
                return {
                    block: structuredClone(result.block),
                    notes,
                    credits,
                    balances: walletBalances(await store.readSnapshot(scope)),
                };
            } catch (error) {
                state = "pending";
                throw error;
            }
        },
    };
}
