import {
    computeNoteCommitment,
    computeNoteIdentity,
    computeNoteNullifier,
    type Note,
} from "@invisi-labs/core";
import {
    buildTransactCalldata,
    normalizeTransactRequest,
    type BuildTransactCalldataParams,
} from "./funds";

export interface BuildWithdrawalCalldataParams extends Omit<
    BuildTransactCalldataParams,
    "deliveries"
> {
    sourceNotes: readonly Note[];
}

/** Prepare a full public withdrawal whose spending authority is already proven in the supplied proof. */
export async function buildWithdrawalCalldata(p: BuildWithdrawalCalldataParams) {
    const r = normalizeTransactRequest(p.context, p.params, [], p.funding);
    if (
        r.outputCount !== 0 ||
        r.depositAmount !== 0n ||
        p.sourceNotes.length === 0 ||
        p.sourceNotes.length !== r.inputCount
    ) {
        throw new Error("full withdrawal requires inputs, no private outputs and no funding");
    }
    const walletIdentity = BigInt(p.sourceNotes[0]!.walletIdentity);
    let total = 0n;
    for (const [index, note] of p.sourceNotes.entries()) {
        if (
            note.chainId !== p.context.chainId ||
            note.protocolAddress !== BigInt(p.context.protocolAddress)
        )
            throw new Error("source note context mismatch");
        if (
            BigInt(note.walletIdentity) !== walletIdentity ||
            note.tokenAddress !== BigInt(p.context.tokenAddress) ||
            note.amount <= 0n
        )
            throw new Error("source note wallet/token/amount mismatch");
        const commitment = await computeNoteCommitment(
            note.chainId,
            await computeNoteIdentity(walletIdentity, note.nonce),
            note.tokenAddress,
            note.amount
        );
        const nullifier = await computeNoteNullifier(note.chainId, note.nonce, commitment);
        if (nullifier.toLowerCase() !== r.nullifiers[index]!.toLowerCase())
            throw new Error("source note nullifier mismatch");
        total += note.amount;
    }
    if (r.withdrawalAmount !== total)
        throw new Error("withdrawal must equal the full input balance");
    return buildTransactCalldata({ ...p, deliveries: [] });
}
