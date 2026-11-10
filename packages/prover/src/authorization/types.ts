import {
    type AuthorizedStatement,
    type CreditDeliveryState,
    type CreditUpdateChanges,
    type Note,
} from "@invisi-labs/primitives";
import { type ProofTarget } from "../index";
import type {
    CreateCreditParams,
    CreditDrawParams,
    Delivery,
    Hex,
    UpdateCreditParams,
} from "@invisi-labs/protocol/contracts";
import { type BuildTransactCalldataParams } from "@invisi-labs/protocol";
import { type FundingInput } from "@invisi-labs/protocol";

export interface NoteMembership {
    note: Note;
    treeId: bigint;
    leafIndex: number;
    path: readonly bigint[];
}

export interface CreditMembership {
    state: CreditDeliveryState;
    treeId: bigint;
    leafIndex: number;
    path: readonly bigint[];
}

export interface TransactWitnessParams extends Omit<
    BuildTransactCalldataParams,
    "proof" | "context"
> {
    inputs: readonly NoteMembership[];
    outputs: readonly (Note | { identity: Hex; amount: bigint; note?: Note })[];
    authorization?: AuthorizedStatement;
    target?: ProofTarget;
}

export interface CreateCreditWitnessParams {
    params: CreateCreditParams;
    deliveries: readonly Delivery[];
    state: CreditDeliveryState;
    authorization: AuthorizedStatement;
}
export interface DrawCreditWitnessParams {
    timestamp: bigint;
    params: CreditDrawParams;
    deliveries: readonly Delivery[];
    inputs: readonly CreditMembership[];
    amounts: readonly bigint[];
    output: Note;
    authorization: AuthorizedStatement;
}
export interface UpdateCreditWitnessParams {
    changes: CreditUpdateChanges;
    params: UpdateCreditParams;
    deliveries: readonly Delivery[];
    input: CreditMembership;
    state: CreditDeliveryState;
    authorization: AuthorizedStatement;
}
