import type { CreditDeliveryState, Note } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/prover";

export interface WalletScope {
    namespace: string;
    chainId: bigint;
    protocolAddress: Hex;
    ownerAddress: Hex;
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

export interface NoteRecord extends ReceiptPosition {
    note: Note;
    spent: SpentState;
    checkedThrough?: Checkpoint;
}

export interface CreditRecord extends ReceiptPosition {
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
