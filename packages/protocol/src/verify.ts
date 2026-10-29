import {
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    computeNoteCommitment,
    computeNoteIdentity,
    FIELD_MODULUS,
} from "@invisi-labs/core";

export interface VerifyNoteCommitmentParams {
    walletIdentity: `0x${string}`;
    tokenAddress: `0x${string}`;
    amount: bigint;
    nonce: `0x${string}`;
    noteCommitment: `0x${string}`;
    chainId: bigint;
}

export async function verifyNoteCommitment(params: VerifyNoteCommitmentParams): Promise<boolean> {
    const expected = await computeNoteCommitment(
        params.chainId,
        await computeNoteIdentity(BigInt(params.walletIdentity), BigInt(params.nonce)),
        BigInt(params.tokenAddress),
        params.amount
    );
    return BigInt(expected) === BigInt(params.noteCommitment);
}

export interface VerifyCreditCommitmentParams extends Partial<
    import("@invisi-labs/core").CreditPolicy
> {
    chainId: bigint;
    spenderWalletIdentity: `0x${string}`;
    ownerWalletIdentity: `0x${string}`;
    spenderPayout: `0x${string}`;
    ownerPayout: `0x${string}`;
    tokenAddress: `0x${string}`;
    amount: bigint;
    nonce: bigint;
    expiry: bigint;
    creditSharedKey: bigint;
    /** Server-returned value to verify against the locally recomputed commitment. */
    creditCommitment: `0x${string}`;
}

/**
 * Hashes the received shared key locally, recomputes the Credit leaf and compares it to the
 * server-returned value. A mismatch means the server folded a wrong nonce
 * (or other parameter) — the caller MUST abort and not create a Credit.
 */
export async function verifyCreditCommitment(
    params: VerifyCreditCommitmentParams
): Promise<boolean> {
    if (params.creditSharedKey <= 0n || params.creditSharedKey >= FIELD_MODULUS)
        throw new RangeError("creditSharedKey must be a nonzero canonical Field");
    const expected = await computeCreditCommitment(
        params.chainId,
        params.spenderWalletIdentity,
        params.ownerWalletIdentity,
        BigInt(params.spenderPayout),
        BigInt(params.ownerPayout),
        BigInt(params.tokenAddress),
        params.amount,
        params.nonce,
        params.expiry,
        await computeCreditSharedKeyHash(params.creditSharedKey),
        params
    );
    return BigInt(expected) === BigInt(params.creditCommitment);
}
