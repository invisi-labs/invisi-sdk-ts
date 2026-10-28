import { describe, it, expect } from "vitest";
import { poseidonHash } from "@invisi-labs/core";
import { loadCircuit, loadVerificationKey, CIRCUIT_NAMES } from "./circuits";
import { getCircuitKey, getCircuitMetadata } from "./proof-data";
import type { CircuitName } from "./circuit-types";
describe("current authenticated release", () => {
    it.each(CIRCUIT_NAMES)("authenticates %s and its direct key", (name) => {
        const circuit = loadCircuit(name);
        expect(circuit.noir_version).toContain("1.0.0-rc.4");
        expect(circuit.debug_symbols).toBeUndefined();
        expect(circuit.file_map).toBeUndefined();
        expect(loadVerificationKey(name).length).toBeGreaterThan(1000);
    });
    it("publishes the authenticated recursive key fields and hash required by outer witnesses", async () => {
        const key = getCircuitKey("transact_user_slots14", "noir-recursive");
        expect(key.vkSha256).toBe(
            "8fd94d39491615e178a2bac38a3c125eb0ba536e7e8653a01d81d3c93b9ce788"
        );
        expect(key.vkHash).toBe(
            "0x0887b767a1f88fed05b13ba42b4453b2530a996598ce307b26b0c1a43b78cfab"
        );
        expect(key.vkFields).toHaveLength(115);
        expect(key.vkFields!.join("").replaceAll("0x", "")).toBe(key.vkHex.slice(2));
        expect(loadVerificationKey("transact_user_slots14", "noir-recursive")).toHaveLength(3680);
        const pin = await poseidonHash([
            0x494e564953495f5245435552534956455f564b31n,
            ...key.vkFields!.map(BigInt),
            BigInt(key.vkHash!),
        ]);
        expect(pin).toBe("0x0bc908c1f2cf6ef37c530616714fb716e6aa39e14e0a21e16226f5eb348167cc");
        expect(pin).toBe(key.innerVkCommitment);
        for (const count of [4, 8, 12])
            expect(
                getCircuitMetadata(`transact_aggregate_14_${count}` as CircuitName)
                    .innerVkCommitment
            ).toBe(pin);
        key.vkFields![0] = `0x${"00".repeat(32)}`;
        expect(getCircuitKey("transact_user_slots14", "noir-recursive").vkFields![0]).not.toBe(
            key.vkFields![0]
        );
        expect(getCircuitKey("transact_user_slots14").vkFields).toBeUndefined();
    });
    it("publishes only slot14 recursion and outer counts4/8/12", () => {
        expect(getCircuitKey("transact_user_slots14", "noir-recursive").target).toBe(
            "noir-recursive"
        );
        expect(() => getCircuitKey("transact_user_slots56", "noir-recursive")).toThrow(
            "Unsupported"
        );
        expect(() => loadCircuit("transact_aggregate_56_4" as CircuitName)).toThrow("Unknown");
        expect(() => loadCircuit("batch_settle_1" as CircuitName)).toThrow("Unknown");
        expect(getCircuitMetadata("credit_top_up").publicInputCount).toBe(50);
        expect(getCircuitMetadata("wallet_registration").publicInputCount).toBe(3);
        expect(() => getCircuitKey("wallet_registration", "noir-recursive")).toThrow("Unsupported");
        expect(CIRCUIT_NAMES).toHaveLength(15);
    });
});
