import { normalizeCreditDeliveryState } from "@invisi-labs/core";
import type { Hex } from "../contracts/index";
import { check, pad, policyWitness, zeros } from "./common";
import type { CreateCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function creation(
    witness: WitnessContext,
    p: CreateCreditWitnessParams,
    operation: "create-credit" | "top-up-credit",
    words: readonly Hex[]
) {
    const state = normalizeCreditDeliveryState(p.state),
        note = state.note;
    check(
        (await witness.creditLeaf(note)) === p.params.creditCommitment &&
            note.ownerPayout === BigInt(p.params.owner) &&
            note.expiry === p.params.expiry,
        "Credit creation mismatch"
    );
    if (
        operation === "create-credit" &&
        [note.lastDay, note.dailySpent, note.lastMonth, note.monthlySpent].some((v) => v !== 0n)
    )
        throw new Error("new Credit usage must be zero");
    const authority = await witness.authority(
        operation,
        10,
        words,
        p.authorization,
        note.ownerWalletIdentity
    );
    const sources = await witness.noteInputs(
        p.inputs,
        p.params.sources,
        p.params.nullifiers,
        note.ownerWalletIdentity,
        authority
    );
    if (p.change)
        check(
            p.change.ownerAddress === note.ownerWalletIdentity &&
                (await witness.noteLeaf(p.change)) === p.params.changeCommitment,
            "change commitment mismatch"
        );
    else check(BigInt(p.params.changeCommitment) === 0n, "missing change note");
    return {
        ...authority,
        input_amounts: pad(
            p.inputs.map((input) => input.note.amount),
            10,
            () => 0n
        ),
        input_nonces: pad(
            p.inputs.map((input) => input.note.nonce),
            10,
            () => 0n
        ),
        leaf_indices: pad(
            p.inputs.map((input) => BigInt(input.leafIndex)),
            10,
            () => 0n
        ),
        merkle_paths: pad(
            p.inputs.map((input) => [...input.path]),
            10,
            zeros
        ),
        input_source_indices: pad(sources, 10, () => 0n),
        spender_payout: note.spenderPayout,
        spender_wallet_identity: BigInt(note.spenderWalletIdentity),
        owner_wallet_identity: BigInt(note.ownerWalletIdentity),
        ...policyWitness(note, operation === "top-up-credit"),
        credit_amount: note.amount,
        credit_nonce: note.nonce,
        credit_shared_key: note.creditSharedKey,
        change_amount: p.change?.amount ?? 0n,
        change_nonce: p.change?.nonce ?? 0n,
    };
}
