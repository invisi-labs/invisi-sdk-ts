import { type AuthorizedStatement, type CreditDeliveryState, type Note } from "@invisi-labs/core";
import { type ProofTarget } from "@invisi-labs/prover";
import type {
    CancelCreditParams,
    CreateCreditParams,
    CreditDrawParams,
    Delivery,
    Hex,
    TopUpCreditParams,
} from "../contracts/index";
import { type BuildTransactCalldataParams } from "../funds/calldata";
import { type FundingInput } from "../validation";

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
    funding?: FundingInput;
    inputs: readonly NoteMembership[];
    state: CreditDeliveryState;
    change?: Note;
    authorization: AuthorizedStatement;
}

export interface DrawCreditWitnessParams {
    /** Explicit chain timestamp used to prepare this signed statement. */
    timestamp: bigint;
    params: CreditDrawParams;
    deliveries: readonly Delivery[];
    inputs: readonly CreditMembership[];
    amounts: readonly bigint[];
    authorization: AuthorizedStatement;
}

export interface CancelCreditWitnessParams {
    params: CancelCreditParams;
    input: CreditMembership;
    authorization: AuthorizedStatement;
}

export interface TopUpCreditWitnessParams extends Omit<CreateCreditWitnessParams, "params"> {
    params: TopUpCreditParams;
    previous: CreditMembership;
}
