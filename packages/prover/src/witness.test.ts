import { describe, it, expect } from "vitest";
import { generateWitness } from "./witness";
import { loadCircuit } from "./circuits";
import { CANCEL_FIXTURE, USER_FIXTURE, TOP_UP_FIXTURE } from "./test-fixtures";
describe("current rc4 circuits execute with pinned rc3 JavaScript runtime", () => {
    it.each([
        ["credit_cancel", CANCEL_FIXTURE],
        ["transact_user_slots14", USER_FIXTURE],
        ["credit_top_up", TOP_UP_FIXTURE],
    ] as const)("executes deterministic %s fixture", async (name, fixture) => {
        const witness = await generateWitness(loadCircuit(name), fixture.witness);
        expect(Array.from(witness.slice(0, 2))).toEqual([31, 139]);
        expect(witness.length).toBeGreaterThan(1000);
    });
    it("rejects a changed public statement", async () => {
        await expect(
            generateWitness(loadCircuit("credit_cancel"), {
                ...CANCEL_FIXTURE.witness,
                amount: "59",
            })
        ).rejects.toThrow();
    });
});
