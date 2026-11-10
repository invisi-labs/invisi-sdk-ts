import {
    computeNoteIdentity,
    deriveCreditState,
    normalizeCreditPolicy,
    normalizeCreditUsage,
} from "@invisi-labs/primitives";
import type { CircuitName } from "../index";
import { creditDrawPublicInputs, selectCreditDrawCircuit } from "@invisi-labs/protocol";
import { check, pad, provingRequest, zeros } from "./common";
import type { DrawCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function drawCredit(w: WitnessContext, p: DrawCreditWitnessParams) {
    const c = { ...w.protocol.context, timestamp: p.timestamp },
        capacity = selectCreditDrawCircuit(p.inputs.length).capacity,
        words = creditDrawPublicInputs(c, p.params, p.deliveries),
        identity = p.inputs[0]!.state.note.spenderWalletIdentity;
    check(p.inputs.length === p.amounts.length, "draw input count mismatch");
    const totals = p.params.payers.map(() => 0n),
        used = new Set<number>();
    const sourceIndices = await Promise.all(
        p.inputs.map(async (input, i) => {
            const n = input.state.note,
                r = p.params.grantRefs[i]!,
                pi = p.params.payers.findIndex(
                    (payer) => BigInt(payer.payer) === BigInt(n.ownerWalletIdentity)
                );
            check(
                n.spenderWalletIdentity === identity &&
                    n.expiry >= p.params.deadline &&
                    pi >= 0 &&
                    r.payerIndex === BigInt(pi) &&
                    r.shard === n.revocationShard &&
                    r.slot === n.revocationSlot,
                "Credit private group binding mismatch"
            );
            const next = await deriveCreditState(n, p.amounts[i]!, p.timestamp);
            check(
                next.nullifier === p.params.nullifiers[i] &&
                    next.stateCommitment === p.params.creditCommitments[i] &&
                    next.recoveryAmount === BigInt(p.params.recoveryAmounts[i]!),
                "draw public fields mismatch"
            );
            totals[pi] = totals[pi]! + p.amounts[i]!;
            const source = await w.membership(await w.creditLeaf(n), input, p.params.sources);
            used.add(source);
            return BigInt(source);
        })
    );
    check(
        used.size === p.params.sources.length &&
            totals.every((sum, i) => sum === p.params.payers[i]!.amount),
        "unused public group or payer receipt mismatch"
    );
    check(
        p.output.amount === p.params.totalAmount - (p.params.feeAmount ?? 0n) &&
            (await w.noteLeaf(p.output)) === p.params.noteCommitment,
        "output Note mismatch"
    );
    const ns = p.inputs.map((i) => i.state.note),
        policy = ns.map(normalizeCreditPolicy),
        array = (f: (i: number) => bigint) =>
            pad(
                ns.map((_, i) => f(i)),
                capacity,
                () => 0n
            );
    return provingRequest(
        `credit_draw_slots${capacity}` as CircuitName,
        {
            ...(await w.authority("credit-draw", capacity, words, p.authorization, identity)),
            spender_wallet_identity: BigInt(identity),
            input_nonces: array((i) => ns[i]!.nonce),
            expiries: array((i) => ns[i]!.expiry),
            credit_shared_keys: array((i) => ns[i]!.creditSharedKey),
            leaf_indices: array((i) => BigInt(p.inputs[i]!.leafIndex)),
            input_source_indices: pad(sourceIndices, capacity, () => 0n),
            draw_amounts: pad(p.amounts, capacity, () => 0n),
            limits: pad(
                policy.map((n) => [n.singleLimit, n.dailyLimit, n.monthlyLimit]),
                capacity,
                () => [0n, 0n, 0n]
            ),
            available_credits: array((i) => ns[i]!.availableCredit),
            unlimited_flags: pad(
                ns.map((n) => BigInt(n.unlimited)),
                capacity,
                () => 0n
            ),
            usages: pad(
                ns
                    .map(normalizeCreditUsage)
                    .map((n) => [
                        n.lastDay,
                        n.dailySpent,
                        n.lastMonth,
                        n.monthlySpent,
                        n.totalSpent,
                    ]),
                capacity,
                () => [0n, 0n, 0n, 0n, 0n]
            ),
            merkle_paths: pad(
                p.inputs.map((i) => [...i.path]),
                capacity,
                zeros
            ),
            output_identity: BigInt(
                await computeNoteIdentity(BigInt(p.output.ownerAddress), p.output.nonce)
            ),
        },
        words
    );
}
