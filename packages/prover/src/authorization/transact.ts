import { computeNoteCommitment, computeNoteIdentity } from "@invisi-labs/primitives";
import { type ProvingRequest } from "../index";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { transactUserPublicInputs } from "@invisi-labs/protocol";
import { normalizeTransactRequest } from "@invisi-labs/protocol";
import { field, uint, word } from "@invisi-labs/protocol";
import { check, pad, provingRequest, zeroAuthority, zeros } from "./common";
import type { TransactWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function transact(
    witness: WitnessContext,
    p: TransactWitnessParams
): Promise<ProvingRequest> {
    const c = witness.protocol.context,
        n = normalizeTransactRequest(c, p.params, p.deliveries, p.funding),
        words = transactUserPublicInputs(c, p.params, p.deliveries, p.funding);
    check(
        p.inputs.length === n.inputCount && p.outputs.length === n.outputCount,
        "note count mismatch"
    );
    const identity = p.inputs[0]?.note.ownerAddress;
    const unsignedSweep =
        !!identity &&
        !p.authorization &&
        n.outputCount === 0 &&
        n.depositAmount === 0n &&
        n.feeAmount === 0n &&
        BigInt(p.params.withdrawalAddress) === BigInt(identity);
    const authority =
        identity && !unsignedSweep
            ? await witness.authority("transact", n.capacity, words, p.authorization, identity)
            : zeroAuthority();
    const sources = await witness.noteInputs(
        p.inputs,
        p.params.sources,
        p.params.nullifiers,
        identity ?? (("0x" + "00".repeat(32)) as Hex),
        authority
    );
    const outputs = await Promise.all(
        p.outputs.map(async (output, i) => {
            const opening = "identity" in output ? output.note : output;
            const identity =
                "identity" in output
                    ? field(output.identity)
                    : BigInt(await computeNoteIdentity(BigInt(output.ownerAddress), output.nonce));
            const amount = uint(output.amount, 128, "output amount");
            check(identity !== 0n && amount !== 0n, "zero output identity or amount");
            if (opening) {
                witness.context(opening);
                check(
                    opening.amount === amount &&
                        BigInt(
                            await computeNoteIdentity(BigInt(opening.ownerAddress), opening.nonce)
                        ) === identity,
                    "output opening mismatch"
                );
            }
            const commitment = await computeNoteCommitment(
                c.chainId,
                BigInt(c.protocolAddress),
                word(identity),
                BigInt(c.tokenAddress),
                amount
            );
            check(commitment === p.params.noteCommitments[i], "output commitment mismatch");
            return { identity, amount };
        })
    );
    const all = [...p.inputs.map((input) => input.note), ...outputs];
    return provingRequest(
        `transact_user_slots${n.capacity}`,
        {
            input_owner_address: identity ? BigInt(identity) : 0n,
            ...authority,
            output_identities: pad(
                [...p.inputs.map(() => 0n), ...outputs.map((output) => output.identity)],
                n.capacity,
                () => 0n
            ),
            amounts: pad(
                all.map((note) => note.amount),
                n.capacity,
                () => 0n
            ),
            nonces: pad(
                [...p.inputs.map((input) => input.note.nonce), ...outputs.map(() => 0n)],
                n.capacity,
                () => 0n
            ),
            leaf_indices: pad(
                p.inputs.map((input) => BigInt(input.leafIndex)),
                n.capacity,
                () => 0n
            ),
            merkle_paths: pad(
                p.inputs.map((input) => [...input.path]),
                n.capacity,
                zeros
            ),
            input_source_indices: pad(sources, n.capacity, () => 0n),
        },
        words,
        p.target
    );
}
