import { type ProvingRequest } from "@invisi-labs/prover";
import { createCreditPublicInputs } from "../credit/credit-create";
import { provingRequest } from "./common";
import { creation } from "./credit-creation";
import type { CreateCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function createCredit(
    witness: WitnessContext,
    p: CreateCreditWitnessParams
): Promise<ProvingRequest> {
    const words = createCreditPublicInputs(
        witness.protocol.context,
        p.params,
        p.deliveries,
        p.funding
    );
    return provingRequest(
        "create_credit",
        await creation(witness, p, "create-credit", words),
        words
    );
}
