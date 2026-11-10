import type { CreditDeliveryState, Note, Wallet } from "@invisi-labs/primitives";
import type { Protocol } from "@invisi-labs/rpc";
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
    wallet: Wallet & {
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
