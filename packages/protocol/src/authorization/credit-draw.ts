import {
    applyCreditDrawUsage,
    computeCreditNullifier,
    normalizeCreditDeliveryState,
    normalizeCreditPolicy,
} from "@invisi-labs/core";
import { type CircuitName, type ProvingRequest } from "@invisi-labs/prover";
import { creditDrawPublicInputs, selectCreditDrawCircuit } from "../credit/credit-lifecycle";
import { check, pad, provingRequest, zeros } from "./common";
import type { DrawCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function drawCredit(
    witness: WitnessContext,
    p: DrawCreditWitnessParams
): Promise<ProvingRequest> {
    const c = { ...witness.protocol.context, timestamp: p.timestamp },
        profile = selectCreditDrawCircuit(p.inputs.length),
        capacity = profile.maxSize;
    check(
        p.inputs.length === p.amounts.length && p.inputs.length === p.params.nullifiers.length,
        "draw input count mismatch"
    );
    const notes = p.inputs.map((input) => normalizeCreditDeliveryState(input.state).note),
        identity = notes[0]!.spenderWalletIdentity;
    const words = creditDrawPublicInputs(c, p.params, p.deliveries),
        authority = await witness.authority(
            "credit-draw",
            capacity,
            words,
            p.authorization,
            identity
        );
    const sourceIndices = await Promise.all(
        notes.map(async (note, i) => {
            applyCreditDrawUsage(note, p.amounts[i]!, p.timestamp);
            const leaf = await witness.creditLeaf(note);
            check(
                note.spenderWalletIdentity === identity &&
                    note.spenderPayout === BigInt(p.params.spender) &&
                    note.expiry === p.params.expiries[i] &&
                    p.amounts[i]! > 0n &&
                    p.amounts[i]! <= note.amount &&
                    (await computeCreditNullifier(c.chainId, note.creditSharedKey, leaf)) ===
                        p.params.nullifiers[i],
                "Credit draw mismatch"
            );
            return BigInt(await witness.membership(leaf, p.inputs[i]!, p.params.sources));
        })
    );
    return provingRequest(
        profile.name as CircuitName,
        {
            ...authority,
            ...Object.fromEntries(
                Object.entries({
                    singleLimit: "single_limits",
                    dailyLimit: "daily_limits",
                    monthlyLimit: "monthly_limits",
                    lastDay: "last_days",
                    dailySpent: "daily_spents",
                    lastMonth: "last_months",
                    monthlySpent: "monthly_spents",
                }).map(([key, name]) => [
                    name,
                    pad(
                        notes.map(
                            (note) =>
                                normalizeCreditPolicy(note)[
                                    key as keyof ReturnType<typeof normalizeCreditPolicy>
                                ]
                        ),
                        capacity,
                        () => 0n
                    ),
                ])
            ),
            spender_wallet_identity: BigInt(identity),
            owner_payouts: pad(
                notes.map((note) => note.ownerPayout),
                capacity,
                () => 0n
            ),
            owner_wallet_identities: pad(
                notes.map((note) => BigInt(note.ownerWalletIdentity)),
                capacity,
                () => 0n
            ),
            input_amounts: pad(
                notes.map((note) => note.amount),
                capacity,
                () => 0n
            ),
            input_nonces: pad(
                notes.map((note) => note.nonce),
                capacity,
                () => 0n
            ),
            credit_shared_keys: pad(
                notes.map((note) => note.creditSharedKey),
                capacity,
                () => 0n
            ),
            leaf_indices: pad(
                p.inputs.map((input) => BigInt(input.leafIndex)),
                capacity,
                () => 0n
            ),
            merkle_paths: pad(
                p.inputs.map((input) => [...input.path]),
                capacity,
                zeros
            ),
            input_source_indices: pad(sourceIndices, capacity, () => 0n),
            draw_amounts: pad(p.amounts, capacity, () => 0n),
        },
        words
    );
}
