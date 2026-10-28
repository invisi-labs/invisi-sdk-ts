import { poseidonHash } from "./poseidon";
import { D_NULL } from "./domains";
import { FIELD_MODULUS } from "./random";

/** Bind the complete note leaf to its committed private nonce. */
export async function computeNoteNullifier(
    chainId: bigint,
    nonce: bigint,
    commitment: `0x${string}`
): Promise<`0x${string}`> {
    if (chainId < 0n || chainId >= 1n << 64n) throw new RangeError("invalid chainId");
    if (nonce < 0n || nonce >= FIELD_MODULUS) throw new RangeError("invalid note nonce");
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment))
        throw new Error("invalid note commitment encoding");
    return poseidonHash([D_NULL, chainId, nonce, BigInt(commitment)]);
}
