import { describe, expect, it } from "vitest";
import { loadCircuit } from "../circuits/circuits";
import {
    CANCEL_FIXTURE,
    LIMITED_CREATE_FIXTURE,
    LIMITED_DRAW_FIXTURE,
    LIMITED_TOP_UP_FIXTURE,
    TOP_UP_FIXTURE,
    USER_FIXTURE,
} from "../testing/test-fixtures";
import { generateWitness } from "./witness";
describe("current rc4 circuits execute with pinned rc3 JavaScript runtime", () => {
    it.each([
        ["credit_draw_slots1", LIMITED_DRAW_FIXTURE],
        ["credit_top_up", LIMITED_TOP_UP_FIXTURE],
        ["create_credit", LIMITED_CREATE_FIXTURE],
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
