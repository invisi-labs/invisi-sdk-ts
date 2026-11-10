import { FIELD_MODULUS as P } from "./random";
import { INTERNAL_DIAGONAL, ROUND_CONSTANTS } from "./poseidon-constants";
const mod = (n: bigint) => n % P;
const fifth = (n: bigint) => {
    const x = mod(n),
        x2 = mod(x * x);
    return mod(x * x2 * x2);
};
function external(s: bigint[]): void {
    const t0 = s[0]! + s[1]!,
        t1 = s[2]! + s[3]!,
        t2 = 2n * s[1]! + t1,
        t3 = 2n * s[3]! + t0;
    const t4 = 4n * t1 + t3,
        t5 = 4n * t0 + t2;
    s[0] = mod(t3 + t5);
    s[1] = mod(t5);
    s[2] = mod(t2 + t4);
    s[3] = mod(t4);
}
function permute(s: bigint[]): void {
    external(s);
    for (let r = 0; r < 64; r++) {
        const full = r < 4 || r >= 60,
            rc = ROUND_CONSTANTS[r]!;
        if (full) {
            for (let i = 0; i < 4; i++) s[i] = fifth(s[i]! + rc[i]!);
            external(s);
        } else {
            s[0] = fifth(s[0]! + rc[0]!);
            const sum = s.reduce((a, b) => a + b, 0n);
            for (let i = 0; i < 4; i++) s[i] = mod(s[i]! * INTERNAL_DIAGONAL[i]! + sum);
        }
    }
}
/** Barretenberg's length-separated rate-three BN254 Poseidon2 sponge. */
export async function poseidonHash(inputs: bigint[]): Promise<`0x${string}`> {
    for (let i = 0; i < inputs.length; i++)
        if (inputs[i]! < 0n || inputs[i]! >= P)
            throw new RangeError(
                `poseidonHash: input[${i}] out of BN254 field range [0, FIELD_MODULUS): ${inputs[i]}`
            );
    const state = [0n, 0n, 0n, BigInt(inputs.length) << 64n];
    let used = 0;
    for (const input of inputs) {
        if (used === 3) {
            permute(state);
            used = 0;
        }
        state[used] = mod(state[used]! + input);
        used++;
    }
    permute(state);
    return `0x${state[0]!.toString(16).padStart(64, "0")}`;
}
