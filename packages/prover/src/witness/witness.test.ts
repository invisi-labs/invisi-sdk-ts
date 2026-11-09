import { describe, expect, it } from "vitest";
import { loadCircuit } from "../circuits/circuits";
import {
    UPDATE_FIXTURE,
    CREATE_FIXTURE,
    DRAW_FIXTURE,
    USER_FIXTURE,
} from "../testing/test-fixtures";
import { generateWitness } from "./witness";
describe("current Noir1.0.0 circuits execute with the pinned JavaScript runtime", () => {
    it.each([
        ["credit_draw_slots1", DRAW_FIXTURE],
        ["credit_update", UPDATE_FIXTURE],
        ["create_credit", CREATE_FIXTURE],
        ["transact_user_slots2", USER_FIXTURE],
    ] as const)("executes deterministic %s fixture", async (name, fixture) => {
        const witness = await generateWitness(loadCircuit(name), fixture.witness);
        expect(Array.from(witness.slice(0, 2))).toEqual([31, 139]);
        expect(witness.length).toBeGreaterThan(1000);
    });
    it("rejects a changed public statement", async () => {
        await expect(
            generateWitness(loadCircuit("credit_update"), {
                ...UPDATE_FIXTURE.witness,
                credit_commitment: "59",
            })
        ).rejects.toThrow();
    });
});
