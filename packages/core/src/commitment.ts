import { poseidonHash } from "./poseidon";
import { D_IDENT, D_NOTE } from "./domains";

/** Randomized per-note identity; the full wallet identity stays private on chain. */
export async function computeNoteIdentity(
    walletIdentity: bigint,
    nonce: bigint
): Promise<`0x${string}`> {
    if (walletIdentity <= 0n || walletIdentity >= 1n << 160n)
        throw new RangeError("invalid wallet identity");
    return poseidonHash([D_IDENT, walletIdentity, nonce]);
}

/** Note leaf from a randomized identity, token and positive u128 amount. */
export async function computeNoteCommitment(
    chainId: bigint,
    identity: `0x${string}`,
    tokenAddress: bigint,
    amount: bigint
): Promise<`0x${string}`> {
    if (chainId < 0n || chainId >= 1n << 64n) throw new RangeError("invalid chainId");
    if (tokenAddress < 0n || tokenAddress >= 1n << 160n)
        throw new RangeError("invalid token address");
    if (amount <= 0n || amount >= 1n << 128n) throw new RangeError("invalid note amount");
    if (!/^0x[0-9a-fA-F]{64}$/.test(identity)) throw new Error("invalid note identity encoding");
    return poseidonHash([D_NOTE, chainId, BigInt(identity), tokenAddress, amount]);
}
