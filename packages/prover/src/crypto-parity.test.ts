import { expect, it } from "vitest";
import { Barretenberg, BackendType } from "@aztec-foundation/bb.js";
import { poseidonHash } from "@invisi-labs/primitives";
import { FIELD_MODULUS } from "@invisi-labs/protocol";

it("matches the independent BB Poseidon2 runtime across sponge boundaries and canonical field edges", async () => {
    const bb = await Barretenberg.new({ threads: 1, backend: BackendType.Wasm });
    try {
        let seed = 0x123456789abcdefn;
        const sample = () => {
            seed = (seed * 6364136223846793005n + 1442695040888963407n) % FIELD_MODULUS;
            return seed;
        };
        for (const size of [0, 1, 2, 3, 4, 5, 6, 7, 11, 16, 32, 64]) {
            for (const values of [
                Array.from({ length: size }, sample),
                Array<bigint>(size).fill(FIELD_MODULUS - 1n),
            ]) {
                const { hash } = await bb.poseidon2Hash({
                    inputs: values.map((value) =>
                        Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"))
                    ),
                });
                expect(await poseidonHash(values)).toBe(`0x${Buffer.from(hash).toString("hex")}`);
            }
        }
    } finally {
        await bb.destroy();
    }
}, 30000);
