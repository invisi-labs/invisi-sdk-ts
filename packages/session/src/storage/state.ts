import type { Hex } from "@invisi-labs/sdk";

import type {
    Checkpoint,
    CreditRecord,
    NoteRecord,
    OperationStatus,
    WalletScope,
} from "@invisi-labs/sdk/session-support";
export { creditReservationKey } from "@invisi-labs/sdk/session-support";
export type {
    Checkpoint,
    OperationStatus,
    ReceiptPosition,
    SpentState,
    WalletScope,
} from "@invisi-labs/sdk/session-support";
export interface StoredNote extends NoteRecord {
    /** Membership authenticated at an observation block; creation provenance is not yet known. */
    origin?: "membership-import";
}
export interface StoredCredit extends CreditRecord {}

export interface OperationRecord {
    id: string;
    status: OperationStatus;
    inputs: string[];
    deadline?: bigint;
    transactionHash?: Hex;
    confirmedAt?: Checkpoint;
    payload?: unknown;
}

export interface WalletState {
    preparationSnapshot?: import("@invisi-labs/sdk/session-support").PreparationSnapshot;
    schemaVersion: 2;
    scope: WalletScope;
    revision: number;
    notes: Record<string, StoredNote>;
    credits: Record<string, StoredCredit>;
    reservations: Record<string, string>;
    operations: Record<string, OperationRecord>;
    /** Last canonical block observed while processing known candidates; never a completeness claim. */
    observedThrough?: Checkpoint;
    /** Completed contiguous RPC discovery ranges; independent of operation reconciliation. */
    discoveryThrough?: Checkpoint;
    recoveryBoundary?: bigint;
    discoveryRanges?: import("../public-history/coverage").CoverageRange<Checkpoint>[];
    creditReplayFrom?: bigint;
    creditReplayThrough?: Checkpoint;
    creditReplayTarget?: Checkpoint;
    creditReplayRevision?: number;
    invalidated?: string;
    publicHistoryGeneration?: number;
    unresolvedDeliveryCount?: number;
    archiveFenceGeneration?: number;
    /** Authentication ambiguity is retryable and never evidence of an empty account. */
    unresolvedDeliveries?: Record<
        string,
        import("@invisi-labs/sdk/session-support").DeliveryCandidate
    >;
}

export interface WalletStore {
    readonly persistent: boolean;
    restoreReorgedOperations?(scope: WalletScope, fromBlock: bigint): Promise<void>;
    readSummary?(scope: WalletScope): Promise<WalletState>;
    readRecords?(
        scope: WalletScope,
        query: import("./record-wallet").WalletRecordQuery
    ): Promise<import("./record-wallet").WalletRecordPage>;
    readSnapshot(scope: WalletScope): Promise<WalletState>;
    /** Pure synchronous mutation; an optimistic persistent adapter may retry it. */
    transaction<T>(scope: WalletScope, action: (draft: WalletState) => T): Promise<T>;
}

export interface BalanceSnapshot {
    tokenAddress: Hex;
    scope: WalletScope;
    checkedThrough: Checkpoint | null;
    confirmedKnown: bigint;
    reserved: bigint;
    availableKnown: bigint | null;
    invalidated: boolean;
}

export function walletBalance(state: WalletState, tokenAddress: Hex): BalanceSnapshot {
    let confirmedKnown = 0n;
    let reserved = 0n;
    let unknown = !!state.invalidated || Object.keys(state.unresolvedDeliveries ?? {}).length > 0;
    const records = Object.values(state.notes).filter(
        (r) => r.note.tokenAddress === BigInt(tokenAddress)
    );
    const points = records.map((record) => record.checkedThrough);
    let checkedThrough: Checkpoint | null = null;
    if (
        records.length &&
        points.every((point) => point !== undefined) &&
        records.every((record) => record.spent !== "unknown")
    ) {
        checkedThrough = points.reduce((earliest, point) =>
            point!.number < earliest!.number ? point : earliest
        )!;
    } else if (!records.length) {
        checkedThrough = state.observedThrough ?? null;
    }
    if (!records.length && !checkedThrough) {
        unknown = true;
    }
    for (const [id, record] of Object.entries(state.notes)) {
        if (record.note.tokenAddress !== BigInt(tokenAddress)) continue;
        if (record.spent !== "spent") {
            confirmedKnown += record.note.amount;
            if (record.spent === "unknown") {
                unknown = true;
            }
            if (state.reservations[id]) {
                reserved += record.note.amount;
            }
        }
    }
    return {
        tokenAddress,
        scope: { ...state.scope },
        checkedThrough: state.invalidated ? null : checkedThrough ? { ...checkedThrough } : null,
        confirmedKnown,
        reserved,
        availableKnown: unknown ? null : confirmedKnown - reserved,
        invalidated: !!state.invalidated,
    };
}

/** Balances are listed by asset; amounts from different tokens are never added. */
export function walletBalances(state: WalletState): BalanceSnapshot[] {
    const tokens = new Set(
        Object.values(state.notes).map(
            (r) => `0x${r.note.tokenAddress.toString(16).padStart(40, "0")}` as Hex
        )
    );
    return [...tokens].sort().map((token) => walletBalance(state, token));
}
