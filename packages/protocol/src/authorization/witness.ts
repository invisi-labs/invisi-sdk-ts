import {
    type CircuitName,
    type ProofStatement,
    type ProofTarget,
    type ProvingRequest,
} from "@invisi-labs/prover";
import { TokenProtocol } from "../client/TokenProtocol";
import type { Hex } from "../contracts/index";

import { WitnessContext } from "./WitnessContext";
import { witnessStatement } from "./common";
import { cancelCredit } from "./credit-cancel";
import { createCredit } from "./credit-create";
import { drawCredit } from "./credit-draw";
import { topUpCredit } from "./credit-top-up";
import { transact } from "./transact";
import type {
    CancelCreditWitnessParams,
    CreateCreditWitnessParams,
    DrawCreditWitnessParams,
    TopUpCreditWitnessParams,
    TransactWitnessParams,
} from "./types";
export type {
    CancelCreditWitnessParams,
    CreateCreditWitnessParams,
    CreditMembership,
    DrawCreditWitnessParams,
    NoteMembership,
    TopUpCreditWitnessParams,
    TransactWitnessParams,
} from "./types";
/** Assemble witnesses through operation-specific builders with shared validation. */
export class WitnessBuilder {
    readonly #witness: WitnessContext;
    constructor(protocol: TokenProtocol) {
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
    async cancelCredit(p: CancelCreditWitnessParams): Promise<ProvingRequest> {
        return cancelCredit(this.#witness, p);
    }
    async drawCredit(p: DrawCreditWitnessParams): Promise<ProvingRequest> {
        return drawCredit(this.#witness, p);
    }
    async topUpCredit(p: TopUpCreditWitnessParams): Promise<ProvingRequest> {
        return topUpCredit(this.#witness, p);
    }
}
