import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadCircuit } from "../circuits/circuits";
import { generateWitness } from "../witness/witness";
import { ZERO_INPUT_FIXTURE } from "./zero-input-fixture";

// Use the exact ACVM/ABI dependencies of the pinned Noir runtime to decode its
// actual generated witness, rather than asserting only on supplied inputs.
const noirRequire = createRequire(createRequire(import.meta.url).resolve("@noir-lang/noir_js"));
const { decompressWitnessStack } = noirRequire("@noir-lang/acvm_js") as {
    decompressWitnessStack(witness: Uint8Array): { witness: Map<number, string> }[];
};
const { abiDecode } = noirRequire("@noir-lang/noirc_abi") as {
    abiDecode(abi: unknown, witness: Map<number, string>): { inputs: Record<string, string> };
};

describe("actual zero-input transact14 circuit", () => {
    it("executes a real zero-input funding witness and decodes all public words", async () => {
        const fixture = ZERO_INPUT_FIXTURE;
        const circuit = loadCircuit("transact_user_slots14");
        const witness = await generateWitness(circuit, fixture.witness);
        const decoded = abiDecode(circuit.abi, decompressWitnessStack(witness)[0]!.witness);
        const words = circuit.abi.parameters
            .filter((p) => p.visibility === "public")
            .flatMap((p) => {
                const value = decoded.inputs[p.name]!;
                return Array.isArray(value) ? value.map(BigInt) : [BigInt(value)];
            });
        expect(words).toEqual(fixture.publicInputs.map(BigInt));
        expect(BigInt(decoded.inputs.input_count!)).toBe(0n);
    });
    it("rejects private authority metadata and broken funding conservation", async () => {
        const circuit = loadCircuit("transact_user_slots14");
        for (const changes of [{ input_owner_address: "1" }, { deposit_amount: "201" }]) {
            await expect(
                generateWitness(circuit, { ...ZERO_INPUT_FIXTURE.witness, ...changes })
            ).rejects.toThrow();
        }
    });
});
