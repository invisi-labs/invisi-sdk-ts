import { describe, it, expect } from "vitest";
import { checkBBAvailable } from "./backend-bb";
import { generateProofBundle, verifyProofBundle } from "./prover";
import { CANCEL_FIXTURE, USER_FIXTURE, TOP_UP_FIXTURE, SWEEP_FIXTURE } from "./test-fixtures";
import { createRegistrationFixture } from "./registration-fixture";
const bbBin = process.env.INVISI_BB_BIN;
const native = bbBin ? describe : describe.skip;
native("real BB5.2.1 native proving (set INVISI_BB_BIN)", () => {
    it("requires the pinned BB version", async () => {
        expect(await checkBBAvailable(bbBin)).toBe(true);
    });
    it.each([
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
    it("proves and independently verifies wallet_registration", async () => {
        const fixture = await createRegistrationFixture();
        const bundle = await generateProofBundle({
            circuitName: "wallet_registration",
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
