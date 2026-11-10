import {
    type CircuitName,
    type ProofStatement,
    type ProofTarget,
    type ProvingRequest,
} from "../index";
import type { TransactionContext } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";

import { WitnessContext } from "./WitnessContext";
import { witnessStatement } from "./common";
import { createCredit } from "./credit-create";
import { drawCredit } from "./credit-draw";
import { updateCredit } from "./credit-update";
import { transact } from "./transact";
import type {
    CreateCreditWitnessParams,
    DrawCreditWitnessParams,
    UpdateCreditWitnessParams,
    TransactWitnessParams,
} from "./types";
export type {
    CreateCreditWitnessParams,
    CreditMembership,
    DrawCreditWitnessParams,
    NoteMembership,
    UpdateCreditWitnessParams,
    TransactWitnessParams,
} from "./types";
/** Assemble witnesses through operation-specific builders with shared validation. */
export class WitnessBuilder {
    readonly #witness: WitnessContext;
    constructor(protocol: { readonly context: Readonly<TransactionContext> }) {
        this.#witness = new WitnessContext(protocol);
    }
    static statement(
        circuitName: CircuitName,
        expectedPublicInputs: readonly Hex[],
        target: ProofTarget = "evm"
    ): ProofStatement {
        return witnessStatement(circuitName, expectedPublicInputs, target);
    }
    async transact(p: TransactWitnessParams): Promise<ProvingRequest> {
        return transact(this.#witness, p);
    }
    async createCredit(p: CreateCreditWitnessParams): Promise<ProvingRequest> {
        return createCredit(this.#witness, p);
    }
    async drawCredit(p: DrawCreditWitnessParams): Promise<ProvingRequest> {
        return drawCredit(this.#witness, p);
    }
    async updateCredit(p: UpdateCreditWitnessParams): Promise<ProvingRequest> {
        return updateCredit(this.#witness, p);
    }
}
