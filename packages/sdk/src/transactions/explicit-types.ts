import type { CreditDeliveryState, Note, PublicWallet } from "@invisi-labs/core";
import type { Protocol } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransferPreparation,
} from "./operation-types";

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
export type ExplicitCreateCreditPreparation = TransactionIdentity & CreateCreditPreparation;
export type ExplicitDrawCreditPreparation = TransactionIdentity &
    DrawCreditPreparation & { creditInputs: readonly CreditInput[] };
export type ExplicitUpdateCreditPreparation = TransactionIdentity &
    UpdateCreditPreparation & { creditInputs: readonly CreditInput[] };
export type ExplicitRevokeCreditPreparation = TransactionIdentity & RevokeCreditPreparation;
