import { describe, it, expect } from "vitest";
import { checkBBAvailable } from "./backend-bb";
import { generateProofBundle, verifyProofBundle } from "./prover";
import {
    LIMITED_DRAW_FIXTURE,
    LIMITED_TOP_UP_FIXTURE,
    LIMITED_CREATE_FIXTURE,
    CANCEL_FIXTURE,
    USER_FIXTURE,
    TOP_UP_FIXTURE,
    SWEEP_FIXTURE,
} from "./test-fixtures";
import { ZERO_INPUT_FIXTURE } from "./zero-input-fixture";
const bbBin = process.env.BB_BINARY_PATH;
const native = bbBin ? describe : describe.skip;
native("real BB6.0.0 native proving (set BB_BINARY_PATH)", () => {
    it("requires the pinned BB version", async () => {
        expect(await checkBBAvailable(bbBin)).toBe(true);
    });
    it.each([
        ["credit_draw_slots1", LIMITED_DRAW_FIXTURE, "evm"],
        ["credit_top_up", LIMITED_TOP_UP_FIXTURE, "evm"],
        ["create_credit", LIMITED_CREATE_FIXTURE, "evm"],
        ["credit_cancel", CANCEL_FIXTURE, "evm"],
        ["credit_top_up", TOP_UP_FIXTURE, "evm"],
        ["transact_user_slots14", USER_FIXTURE, "evm"],
        ["transact_user_slots14", SWEEP_FIXTURE, "evm"],
        ["transact_user_slots14", USER_FIXTURE, "noir-recursive"],
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
            circuitName: "transact_user_slots14",
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
