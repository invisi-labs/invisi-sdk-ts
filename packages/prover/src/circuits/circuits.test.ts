import { hasInitialPaymentTestResources } from "../testing/resource-options";
import { poseidonHash } from "@invisi-labs/primitives";
import { AGGREGATE_ROUTES } from "@invisi-labs/protocol";
import { describe, it, expect } from "vitest";
import { getCircuitKey, getCircuitMetadata } from "../proofs/proof-data";
import { CIRCUIT_NAMES, loadCircuit, loadVerificationKey } from "./circuits";
describe("current authenticated release", () => {
    it.each(
        CIRCUIT_NAMES.filter(
            (name) => name !== "create_credit_initial_payment" || hasInitialPaymentTestResources
        )
    )("authenticates %s and its direct key", (name) => {
        const circuit = loadCircuit(name);
        expect(circuit.noir_version).toMatch(/^1\.0\.0\+/);
        expect(circuit.debug_symbols).toBeUndefined();
        expect(circuit.file_map).toBeUndefined();
        expect(loadVerificationKey(name).length).toBeGreaterThan(1000);
    });
    it("publishes28 direct Note,34 aggregate and16 direct Credit circuits", () => {
        expect(CIRCUIT_NAMES.filter((n) => n.startsWith("transact_user_"))).toHaveLength(28);
        expect(CIRCUIT_NAMES.filter((n) => n.startsWith("transact_aggregate_"))).toHaveLength(34);
        expect(CIRCUIT_NAMES.filter((n) => !n.startsWith("transact_"))).toHaveLength(16);
    });
    it("authenticates each C1..C10 native key and dedicated outer pin", async () => {
        for (let c = 1; c <= 10; c++) {
            const key = getCircuitKey(`transact_user_slots${c}` as any, "noir-recursive");
            expect(key.vkFields).toHaveLength(115);
            expect(key.vkFields!.join("").replaceAll("0x", "")).toBe(key.vkHex.slice(2));
            const pin = await poseidonHash([
                0x494e564953495f5245435552534956455f564b31n,
                ...key.vkFields!.map(BigInt),
                BigInt(key.vkHash!),
            ]);
            expect(pin).toBe(key.innerVkCommitment);
            for (const count of [1, 2, 5])
                expect(
                    getCircuitMetadata(`transact_aggregate_${c}_${count}` as any).innerVkCommitment
                ).toBe(pin);
        }
    });
    it("pins all five trusted keys in every mixed route and rejects unpublished recursion", () => {
        for (const route of AGGREGATE_ROUTES.filter((r) => r.kind === "mixed"))
            expect(getCircuitMetadata(route.name as any).innerVkCommitments).toEqual(
                [1, 2, 3, 4, 5].map(
                    (c) =>
                        getCircuitKey(`transact_user_slots${c}` as any, "noir-recursive")
                            .innerVkCommitment
                )
            );
        for (const name of [
            "transact_user_slots20",
            "create_credit",
            "credit_update",
            "credit_draw_slots1",
        ] as const)
            expect(() => getCircuitKey(name, "noir-recursive")).toThrow();
    });
});
