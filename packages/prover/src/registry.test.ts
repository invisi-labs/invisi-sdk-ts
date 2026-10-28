import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadCircuit } from "./circuits";
import { generateWitness } from "./witness";
import { createRegistrationFixture } from "./registration-fixture";

// Use the exact ACVM/ABI dependencies of the pinned Noir runtime to decode its
// actual generated witness, rather than asserting only on supplied inputs.
const noirRequire = createRequire(createRequire(import.meta.url).resolve("@noir-lang/noir_js"));
const { decompressWitnessStack } = noirRequire("@noir-lang/acvm_js") as {
    decompressWitnessStack(witness: Uint8Array): { witness: Map<number, string> }[];
};
const { abiDecode } = noirRequire("@noir-lang/noirc_abi") as {
    abiDecode(abi: unknown, witness: Map<number, string>): { inputs: Record<string, string> };
};

describe("actual wallet_registration Noir authorization", () => {
    it.each([false, true])(
        "executes the deterministic signed fixture (update=%s) and checks all three public words",
        async (update) => {
            const fixture = await createRegistrationFixture({ update });
            const circuit = loadCircuit("wallet_registration");
            const witness = await generateWitness(circuit, fixture.witness);
            expect(Array.from(witness.slice(0, 2))).toEqual([31, 139]);
            const decoded = abiDecode(circuit.abi, decompressWitnessStack(witness)[0]!.witness);
            const names = circuit.abi.parameters
                .filter((parameter) => parameter.visibility === "public")
                .map((parameter) => parameter.name);
            expect(names).toEqual(["wallet_identity", "auth_digest_high", "auth_digest_low"]);
            expect(names.map((name) => BigInt(decoded.inputs[name]!))).toEqual(
                fixture.publicInputs.map(BigInt)
            );
            expect(BigInt(fixture.publicInputs[0])).toBe(
                BigInt("0x1a642f0e3c3af545e7acbd38b07251b3990914f1")
            );
            expect(Object.keys(fixture).sort()).toEqual(["publicInputs", "witness"]);
        }
    );
    it("rejects mutated spending key, signature, wallet identity, and signed statement", async () => {
        const fixture = await createRegistrationFixture();
        const circuit = loadCircuit("wallet_registration");
        const mutations = [
            (input: typeof fixture.witness) => {
                input.public_key_x[0] = input.public_key_x[0]! ^ 1;
            },
            (input: typeof fixture.witness) => {
                input.signature[0] = input.signature[0]! ^ 1;
            },
            (input: typeof fixture.witness) => {
                input.wallet_identity = (BigInt(input.wallet_identity) + 1n).toString();
            },
            (input: typeof fixture.witness) => {
                input.auth_digest_low = (BigInt(input.auth_digest_low) + 1n).toString();
            },
        ];
        for (const mutate of mutations) {
            const input = structuredClone(fixture.witness);
            mutate(input);
            await expect(generateWitness(circuit, input)).rejects.toThrow();
        }
    });
});
