import { firstScanRange } from "../public-history/scan-order";
import type { DeliveryDecryptor } from "@invisi-labs/primitives";
import type { WalletSessionInfrastructure } from "../operations/operation-types";
import type { WalletScope } from "../storage/state";
import { PublicHistory, reportProgress, type AcquiredHistoryPage } from "../public-history/history";
import { scanAccount } from "../public-history/scan";
import type { RefreshOptions, RefreshResult } from "./refresh";

export interface PendingWalletRefresh {
    readonly block: RefreshResult["block"];
    decrypt(decryptor: DeliveryDecryptor): Promise<RefreshResult>;
}
/** Public download commits page by page; private batches commit only after App authentication. */
export async function prepareWalletRefresh(
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    settings: RefreshOptions,
    history: PublicHistory
): Promise<PendingWalletRefresh> {
    const base = await options.store!.readSnapshot(scope);
    if (settings.detectionKey)
        throw Error(
            "WalletSession detection keys must remain in the App; inject batch detection instead"
        );
    let block: RefreshResult["block"];
    let staged: AcquiredHistoryPage | undefined;
    if (settings.offline) {
        const snapshot = await history.snapshot();
        const target =
            settings.toBlock ?? snapshot.coverage?.at(-1)?.block.number ?? snapshot.through?.number;
        if (target === undefined) throw Error("public history has no complete checkpoint");
        const page = await history.options.store.pageAt(history.scope, target);
        const cached = page?.headers.find((h) => h.number === target);
        if (!cached) throw Error("public history target unavailable offline");
        block = cached;
    } else {
        const status =
            settings.toBlock === undefined
                ? await options.protocolRpc!.getStatus(options.protocol.context)
                : undefined;
        const target = settings.toBlock ?? status?.indexedHead?.number;
        if (target === undefined) throw Error("Protocol RPC has not indexed history");
        const size = settings.pageSize ?? 100;
        if (!Number.isInteger(size) || size < 1 || size > 256)
            throw Error("public page size must be 1..256");
        const lower = settings.fromBlock ?? history.scope.deploymentBlock;
        const initial = firstScanRange(
            base,
            await history.snapshot(),
            history.scope.deploymentBlock,
            lower,
            target,
            size,
            !!settings.reset
        );
        const stagingOptions = {
            pageSize: size,
            ...(settings.signal ? { signal: settings.signal } : {}),
            ...(settings.onProgress
                ? {
                      onProgress: (progress: import("../public-history/history").HistoryProgress) =>
                          reportProgress(settings.onProgress, { ...progress, target }),
                  }
                : {}),
        };
        if (initial)
            staged = await history.acquirePage(initial.fromBlock, initial.toBlock, stagingOptions);
        else
            await history.synchronize({
                ...stagingOptions,
                fromBlock: target + 1n,
                toBlock: target,
            });
        block = await options.chainReader!.getBlock(target);
    }
    let state: "pending" | "applying" | "applied" = "pending",
        attempted = false;
    return {
        block: structuredClone(block),
        async decrypt(decryptor) {
            if (state !== "pending") throw Error("wallet refresh already applying or applied");
            state = "applying";
            try {
                if (
                    !attempted &&
                    (await options.store!.readSnapshot(scope)).revision !== base.revision
                )
                    throw Error("wallet changed during refresh; prepare again");
                attempted = true;
                const result = await scanAccount(
                    history,
                    options,
                    scope,
                    decryptor,
                    {
                        ...settings,
                        toBlock: block.number,
                    },
                    staged
                );
                staged = undefined;
                state = "applied";
                return result;
            } catch (error) {
                state = "pending";
                throw error;
            }
        },
    };
}
