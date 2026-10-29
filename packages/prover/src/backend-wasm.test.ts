import { describe, it, expect } from "vitest";
import { generateProofBundle as proveBrowser, verifyProofBundle as verifyBrowser } from "./wasm";
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
const wasm = process.env.INVISI_TEST_WASM === "1" ? describe : describe.skip;
wasm("real WASM/native interoperability (set INVISI_TEST_WASM=1)", () => {
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
        "proves through browser entry and cross-verifies case %#",
        async (circuitName, fixture, target) => {
            const bundle = await proveBrowser({
                circuitName,
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target,
                threads: 4,
            });
            expect(await verifyBrowser(bundle, { threads: 4 })).toBe(true);
            if (process.env.BB_BINARY_PATH) {
                expect(await verifyProofBundle(bundle, { bbBin: process.env.BB_BINARY_PATH })).toBe(
                    true
                );
                const native = await generateProofBundle({
                    circuitName,
                    inputs: fixture.witness,
                    target,
                    bbBin: process.env.BB_BINARY_PATH,
                });
                expect(await verifyBrowser(native, { threads: 4 })).toBe(true);
            }
        },
        600_000
    );
    it("proves zero-input transact14 through browser entry and cross-verifies", async () => {
        const fixture = ZERO_INPUT_FIXTURE;
        const bundle = await proveBrowser({
            circuitName: "transact_user_slots14",
            inputs: fixture.witness,
            expectedPublicInputs: fixture.publicInputs,
            target: "evm",
            threads: 4,
        });
        expect(await verifyBrowser(bundle, { threads: 4 })).toBe(true);
        expect(bundle.publicInputs).toEqual(fixture.publicInputs);
        if (process.env.BB_BINARY_PATH) {
            expect(await verifyProofBundle(bundle, { bbBin: process.env.BB_BINARY_PATH })).toBe(
                true
            );
            const native = await generateProofBundle({
                circuitName: "transact_user_slots14",
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target: "evm",
                bbBin: process.env.BB_BINARY_PATH,
            });
            expect(await verifyBrowser(native, { threads: 4 })).toBe(true);
        }
    }, 600_000);
});
