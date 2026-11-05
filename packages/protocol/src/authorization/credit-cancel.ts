import { computeCreditNullifier, normalizeCreditDeliveryState } from "@invisi-labs/core";
import { type ProvingRequest } from "@invisi-labs/prover";
import { cancelCreditPublicInputs } from "../credit/credit-lifecycle";
import { check, policyWitness, provingRequest } from "./common";
import type { CancelCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function cancelCredit(
    witness: WitnessContext,
    p: CancelCreditWitnessParams
): Promise<ProvingRequest> {
    const note = normalizeCreditDeliveryState(p.input.state).note,
        leaf = await witness.creditLeaf(note),
        c = witness.protocol.context;
    check(
        (await computeCreditNullifier(c.chainId, note.creditSharedKey, leaf)) ===
            p.params.nullifier &&
            note.amount === p.params.amount &&
            note.ownerPayout === BigInt(p.params.owner),
        "Credit cancellation mismatch"
    );
    await witness.membership(leaf, p.input, [p.params.source]);
    const words = cancelCreditPublicInputs(c, p.params),
        authority = await witness.authority(
            "cancel-credit",
            1,
            words,
            p.authorization,
            note.ownerWalletIdentity
        );
    return provingRequest(
        "credit_cancel",
        {
            ...authority,
            spender_payout: note.spenderPayout,
            spender_wallet_identity: BigInt(note.spenderWalletIdentity),
            owner_wallet_identity: BigInt(note.ownerWalletIdentity),
            ...policyWitness(note),
            input_nonce: note.nonce,
            expiry: note.expiry,
            credit_shared_key: note.creditSharedKey,
            leaf_index: BigInt(p.input.leafIndex),
            merkle_path: [...p.input.path],
        },
        words
    );
}
