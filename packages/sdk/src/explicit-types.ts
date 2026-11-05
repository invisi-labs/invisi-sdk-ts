import type { PublicWallet } from "@invisi-labs/core";
import type { CreditDeliveryState, Note } from "@invisi-labs/core";
import type { Protocol } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type {
    CancelCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    ShieldPreparation,
    TopUpCreditPreparation,
    TransferPreparation,
} from "./transactions/operation-types";

export interface NoteInput {
    note: Note;
    commitment: Hex;
    treeId: bigint;
    leafIndex: number;
}
export interface CreditInput {
    state: CreditDeliveryState;
    commitment: Hex;
    treeId: bigint;
    leafIndex: number;
    role: "owner" | "spender";
}
export interface TransactionIdentity {
    wallet: PublicWallet & {
        getViewer?: never;
        getDetector?: never;
        exportAuthorization?: never;
    };
    protocol: Protocol;
}
export interface ExplicitFunds {
    inputs: readonly NoteInput[];
    changeAddress?: string;
}
export type ExplicitTransferPreparation = TransactionIdentity & TransferPreparation & ExplicitFunds;
export type ExplicitShieldPreparation = TransactionIdentity & ShieldPreparation;
export type ExplicitCreateCreditPreparation = TransactionIdentity &
    CreateCreditPreparation &
    ExplicitFunds;
export type ExplicitDrawCreditPreparation = TransactionIdentity &
    DrawCreditPreparation & { creditInputs: readonly CreditInput[] };
export type ExplicitTopUpCreditPreparation = TransactionIdentity &
    TopUpCreditPreparation &
    ExplicitFunds & { creditInputs: readonly CreditInput[] };
export type ExplicitCancelCreditPreparation = TransactionIdentity &
    CancelCreditPreparation & { creditInputs: readonly CreditInput[] };
