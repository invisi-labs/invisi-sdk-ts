import { hexlify } from "ethers";

// Barretenberg 6.0 decompresses BN254 G1 points in 4 MiB batches of 32-byte points.
const POINTS_PER_BATCH = 131_072;

export function wasmSrsSize(verificationKey: Uint8Array): number {
    if (verificationKey.length < 32) throw new Error("Invalid verification key circuit size");
    const logN = BigInt(hexlify(verificationKey.subarray(0, 32)));
    if (logN < 1n || logN > 28n) throw new Error("Invalid verification key circuit size");
    const required = 2 ** Number(logN) + 1;
    return Math.ceil(required / POINTS_PER_BATCH) * POINTS_PER_BATCH;
}
