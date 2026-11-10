import { D_IDENT, D_NOTE } from "../crypto/domains";
import { poseidonHash } from "../crypto/poseidon";

/** Randomized per-note identity; the full owner address stays private on chain. */
export async function computeNoteIdentity(
    ownerAddress: bigint,
    nonce: bigint
): Promise<`0x${string}`> {
    if (ownerAddress <= 0n || ownerAddress >= 1n << 160n)
        throw new RangeError("invalid owner address");
    return poseidonHash([D_IDENT, ownerAddress, nonce]);
}

/** Note leaf from a randomized identity, token and positive u128 amount. */
export async function computeNoteCommitment(
    chainId: bigint,
    protocolAddress: bigint,
    identity: `0x${string}`,
    tokenAddress: bigint,
    amount: bigint
): Promise<`0x${string}`> {
    if (chainId < 0n || chainId >= 1n << 64n) throw new RangeError("invalid chainId");
    if (protocolAddress <= 0n || protocolAddress >= 1n << 160n)
        throw new RangeError("invalid protocol address");
    if (tokenAddress < 0n || tokenAddress >= 1n << 160n)
        throw new RangeError("invalid token address");
    if (amount <= 0n || amount >= 1n << 128n) throw new RangeError("invalid note amount");
    if (!/^0x[0-9a-fA-F]{64}$/.test(identity)) throw new Error("invalid note identity encoding");
    return poseidonHash([D_NOTE, chainId, protocolAddress, BigInt(identity), tokenAddress, amount]);
}
