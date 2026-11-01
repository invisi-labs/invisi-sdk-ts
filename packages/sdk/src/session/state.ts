import type { CreditDeliveryState, Note } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/prover";

export interface WalletScope {
    namespace: string;
    chainId: bigint;
    protocolAddress: Hex;
    walletIdentity: Hex;
}

export function creditReservationKey(commitment: string): string {
    return "credit:" + commitment;
}

export interface Checkpoint {
    number: bigint;
    hash: Hex;
}

export type SpentState = "unknown" | "unspent" | "spent";

export interface ReceiptPosition {
    commitment: Hex;
    treeId: bigint;
    leafIndex: number;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash?: Hex;
}

export interface StoredNote extends ReceiptPosition {
    note: Note;
    spent: SpentState;
    checkedThrough?: Checkpoint;
}

export interface StoredCredit extends ReceiptPosition {
    receivingKeySource?: { kind: "draw" | "top-up"; commitment: Hex };
    state: CreditDeliveryState;
    role: "owner" | "spender";
    spent: SpentState;
    checkedThrough?: Checkpoint;
}

export type OperationStatus =
    | "prepared"
    | "authorized"
    | "proved"
    | "ready"
    | "submitted"
    | "confirmed"
    | "failed"
    | "expired"
    | "uncertain"
    | "reorged";

export interface OperationRecord {
    id: string;
    status: OperationStatus;
    inputs: string[];
    deadline?: bigint;
    transactionHash?: Hex;
    payload?: unknown;
}

export interface WalletState {
    schemaVersion: 1;
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
    invalidated?: string;
}

export interface WalletStore {
    readonly persistent: boolean;
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
    let unknown = !!state.invalidated;
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
