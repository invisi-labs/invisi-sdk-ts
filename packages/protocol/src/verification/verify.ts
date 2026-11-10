import {
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    computeNoteCommitment,
    computeNoteIdentity,
    FIELD_MODULUS,
} from "@invisi-labs/primitives";

export interface VerifyNoteCommitmentParams {
    ownerAddress: `0x${string}`;
    tokenAddress: `0x${string}`;
    amount: bigint;
    nonce: `0x${string}`;
    noteCommitment: `0x${string}`;
    chainId: bigint;
    protocolAddress: `0x${string}`;
}

export async function verifyNoteCommitment(params: VerifyNoteCommitmentParams): Promise<boolean> {
    const expected = await computeNoteCommitment(
        params.chainId,
        BigInt(params.protocolAddress),
        await computeNoteIdentity(BigInt(params.ownerAddress), BigInt(params.nonce)),
        BigInt(params.tokenAddress),
        params.amount
    );
    return BigInt(expected) === BigInt(params.noteCommitment);
}

export interface VerifyCreditCommitmentParams {
    state: import("@invisi-labs/primitives").CreditState;
    creditCommitment: `0x${string}`;
}
export async function verifyCreditCommitment(p: VerifyCreditCommitmentParams): Promise<boolean> {
    return (await computeCreditCommitment(p.state)) === p.creditCommitment;
}
