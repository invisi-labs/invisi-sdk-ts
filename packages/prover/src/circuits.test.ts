import { describe, it, expect } from "vitest";
import { poseidonHash } from "@invisi-labs/core";
import { loadCircuit, loadVerificationKey, CIRCUIT_NAMES } from "./circuits";
import { getCircuitKey, getCircuitMetadata } from "./proof-data";
import type { CircuitName } from "./circuit-types";
describe("current authenticated release", () => {
    it.each(CIRCUIT_NAMES)("authenticates %s and its direct key", (name) => {
        const circuit = loadCircuit(name);
        expect(circuit.noir_version).toContain("1.0.0-rc.6");
        expect(circuit.debug_symbols).toBeUndefined();
        expect(circuit.file_map).toBeUndefined();
        expect(loadVerificationKey(name).length).toBeGreaterThan(1000);
    });
    it("publishes the authenticated recursive key fields and hash required by outer witnesses", async () => {
        const key = getCircuitKey("transact_user_slots14", "noir-recursive");
        expect(key.vkSha256).toBe(
            "912191fc9484b2c0ab869d44900054b1a7c25c3256177abfc102884f3fa7d7ed"
        );
        expect(key.vkHash).toBe(
            "0x093c5faf4911dd51d3ba6d1c630ba7bd89ee957f936c7636af31c7508538af9a"
        );
        expect(key.vkFields).toHaveLength(115);
        expect(key.vkFields!.join("").replaceAll("0x", "")).toBe(key.vkHex.slice(2));
        expect(loadVerificationKey("transact_user_slots14", "noir-recursive")).toHaveLength(3680);
        const pin = await poseidonHash([
            0x494e564953495f5245435552534956455f564b31n,
            ...key.vkFields!.map(BigInt),
            BigInt(key.vkHash!),
        ]);
        expect(pin).toBe("0x097e281d15d80a6e919fe62b0b57bf9502ebe585615c974f264066013d89ed6c");
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
        expect(getCircuitMetadata("credit_top_up").publicInputCount).toBe(52);
        expect(() => loadCircuit("wallet_registration" as CircuitName)).toThrow("Unknown");
        expect(CIRCUIT_NAMES).toHaveLength(14);
    });
});
