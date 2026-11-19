import INITIAL_PAYMENT_FIXTURE from "../testing/initial-payment-fixture.json";
import { testResourceOptions, hasInitialPaymentTestResources } from "../testing/resource-options";
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
import { generateProofBundle as proveBrowser, verifyProofBundle as verifyBrowser } from "../wasm";
const wasm = process.env.INVISI_TEST_WASM === "1" ? describe : describe.skip;
wasm("real WASM/native interoperability (set INVISI_TEST_WASM=1)", () => {
    it.each([
        ["credit_draw_slots1", DRAW_FIXTURE, "evm"],
        ["credit_update", UPDATE_FIXTURE, "evm"],
        ["create_credit", CREATE_FIXTURE, "evm"],
        ...(hasInitialPaymentTestResources
            ? [["create_credit_initial_payment", INITIAL_PAYMENT_FIXTURE, "evm"] as const]
            : []),
        ["transact_user_slots2", USER_FIXTURE, "evm"],
        ["transact_user_slots1", SWEEP_FIXTURE, "evm"],
        ["transact_user_slots2", USER_FIXTURE, "noir-recursive"],
    ] as const)(
        "proves through browser entry and cross-verifies case %#",
        async (circuitName, fixture, target) => {
            const bundle = await proveBrowser({
                resources: testResourceOptions,
                circuitName,
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target,
                threads: 4,
            });
            expect(
                await verifyBrowser(bundle, { threads: 4, resources: testResourceOptions })
            ).toBe(true);
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
                expect(
                    await verifyBrowser(native, { threads: 4, resources: testResourceOptions })
                ).toBe(true);
            }
        },
        600_000
    );
    it("proves through the native entry with WASM using only Node offline resources", async () => {
        const bundle = await generateProofBundle({
            circuitName: "transact_user_slots1",
            inputs: SWEEP_FIXTURE.witness,
            expectedPublicInputs: SWEEP_FIXTURE.publicInputs,
            backend: "wasm",
            threads: 1,
            resources: {
                offline: true,
                ...(process.env.INVISI_PROVER_RESOURCE_DIR
                    ? { directory: process.env.INVISI_PROVER_RESOURCE_DIR }
                    : {}),
            },
        });
        expect(
            await verifyProofBundle(bundle, {
                backend: "wasm",
                threads: 1,
                resources: { offline: true },
            })
        ).toBe(true);
    }, 600_000);
    it("proves zero-input transact14 through browser entry and cross-verifies", async () => {
        const fixture = ZERO_INPUT_FIXTURE;
        const bundle = await proveBrowser({
            resources: testResourceOptions,
            circuitName: "transact_user_slots2",
            inputs: fixture.witness,
            expectedPublicInputs: fixture.publicInputs,
            target: "evm",
            threads: 4,
        });
        expect(await verifyBrowser(bundle, { threads: 4, resources: testResourceOptions })).toBe(
            true
        );
        expect(bundle.publicInputs).toEqual(fixture.publicInputs);
        if (process.env.BB_BINARY_PATH) {
            expect(await verifyProofBundle(bundle, { bbBin: process.env.BB_BINARY_PATH })).toBe(
                true
            );
            const native = await generateProofBundle({
                circuitName: "transact_user_slots2",
                inputs: fixture.witness,
                expectedPublicInputs: fixture.publicInputs,
                target: "evm",
                bbBin: process.env.BB_BINARY_PATH,
            });
            expect(
                await verifyBrowser(native, { threads: 4, resources: testResourceOptions })
            ).toBe(true);
        }
    }, 600_000);
});
