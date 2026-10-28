import { describe, it, expect } from "vitest";
import { generateProofBundle as proveBrowser, verifyProofBundle as verifyBrowser } from "./wasm";
import { generateProofBundle, verifyProofBundle } from "./prover";
import { CANCEL_FIXTURE, USER_FIXTURE, TOP_UP_FIXTURE, SWEEP_FIXTURE } from "./test-fixtures";
import { createRegistrationFixture } from "./registration-fixture";
const wasm = process.env.INVISI_TEST_WASM === "1" ? describe : describe.skip;
wasm("real WASM/native interoperability (set INVISI_TEST_WASM=1)", () => {
    it.each([
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
            if (process.env.INVISI_BB_BIN) {
                expect(await verifyProofBundle(bundle, { bbBin: process.env.INVISI_BB_BIN })).toBe(
                    true
                );
                const native = await generateProofBundle({
                    circuitName,
                    inputs: fixture.witness,
                    target,
                    bbBin: process.env.INVISI_BB_BIN,
                });
                expect(await verifyBrowser(native, { threads: 4 })).toBe(true);
            }
        },
        600_000
    );
    it("proves wallet_registration through browser entry and cross-verifies", async () => {
        const fixture = await createRegistrationFixture();
        const bundle = await proveBrowser({
            circuitName: "wallet_registration",
            inputs: fixture.witness,
            expectedPublicInputs: fixture.publicInputs,
            target: "evm",
            threads: 4,
        });
        expect(await verifyBrowser(bundle, { threads: 4 })).toBe(true);
        expect(bundle.publicInputs).toEqual(fixture.publicInputs);
        if (process.env.INVISI_BB_BIN) {
            expect(await verifyProofBundle(bundle, { bbBin: process.env.INVISI_BB_BIN })).toBe(
                true
            );
            const native = await generateProofBundle({
                circuitName: "wallet_registration",
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target: "evm",
                bbBin: process.env.INVISI_BB_BIN,
            });
            expect(await verifyBrowser(native, { threads: 4 })).toBe(true);
        }
    }, 600_000);
});
