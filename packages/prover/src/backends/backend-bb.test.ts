import { hasFirstDrawTestResources } from "../testing/resource-options";
import FIRST_DRAW_FIXTURE from "../testing/first-draw-fixture.json";
import { describe, expect, it } from "vitest";
import { generateProofBundle, verifyProofBundle } from "../proofs/prover";
import {
    UPDATE_FIXTURE,
    CREATE_FIXTURE,
    DRAW_FIXTURE,
    SWEEP_FIXTURE,
    USER_FIXTURE,
} from "../testing/test-fixtures";
import { ZERO_INPUT_FIXTURE } from "../testing/zero-input-fixture";
import { checkBBAvailable } from "./backend-bb";
const bbBin = process.env.BB_BINARY_PATH;
const native = bbBin ? describe : describe.skip;
native("real BB6.0.0 native proving (set BB_BINARY_PATH)", () => {
    it("requires the pinned BB version", async () => {
        expect(await checkBBAvailable(bbBin)).toBe(true);
    });
    it.each([
        ["credit_draw_slots1", DRAW_FIXTURE, "evm"],
        ["credit_update", UPDATE_FIXTURE, "evm"],
        ["create_credit", CREATE_FIXTURE, "evm"],
        ...(hasFirstDrawTestResources
            ? [["create_credit_and_draw", FIRST_DRAW_FIXTURE, "evm"] as const]
            : []),
        ["transact_user_slots2", USER_FIXTURE, "evm"],
        ["transact_user_slots1", SWEEP_FIXTURE, "evm"],
        ["transact_user_slots2", USER_FIXTURE, "noir-recursive"],
    ] as const)(
        "proves and independently verifies case %#",
        async (circuitName, fixture, target) => {
            const bundle = await generateProofBundle({
                circuitName,
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target,
                bbBin: bbBin!,
                threads: 4,
            });
            expect(bundle.proofHex.length).toBeGreaterThan(1000);
            expect(await verifyProofBundle(bundle, { bbBin: bbBin! })).toBe(true);
            const changed = { ...bundle, publicInputs: [...bundle.publicInputs] };
            changed.publicInputs[0] = `0x${"00".repeat(32)}`;
            await expect(verifyProofBundle(changed, { bbBin: bbBin! })).rejects.toThrow();
        },
        600_000
    );
    it("proves and independently verifies zero-input transact14", async () => {
        const fixture = ZERO_INPUT_FIXTURE;
        const bundle = await generateProofBundle({
            circuitName: "transact_user_slots2",
            inputs: fixture.witness,
            expectedPublicInputs: fixture.publicInputs,
            target: "evm",
            bbBin: bbBin!,
            threads: 4,
        });
        expect(await verifyProofBundle(bundle, { bbBin: bbBin! })).toBe(true);
        expect(bundle.publicInputs).toEqual(fixture.publicInputs);
        const changed = { ...bundle, publicInputs: [...bundle.publicInputs] };
        changed.publicInputs[0] = `0x${"00".repeat(32)}`;
        await expect(verifyProofBundle(changed, { bbBin: bbBin! })).rejects.toThrow();
    }, 600_000);
});
