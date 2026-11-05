import { describe, expect, it } from "vitest";

describe("canonical protocol exports", () => {
    it("does not expose application secret derivations or retired protocol formulas", async () => {
        const mod = await import("./index");
        expect(typeof mod.computeNoteIdentity).toBe("function");
        for (const name of [
            "computeIdentityCommitment",
            "bytesToField",
            "deriveNoteSecret",
            "D_NOTE_SECRET",
            "computeNullifier",
            "deriveNullifierKey",
            "computeNullifierKeyHash",
            "VERSION",
            "D_NKEY",
            "D_PAY",
            "D_NKHASH",
            "deriveCreditNullifierKey",
            "deriveChangeNullifierKey",
            "deriveRemainderNullifierKey",
            "computeRefundLink",
            "D_DERIVE",
            "D_REFLINK",
            "D_CREDIT_NKEY",
            "D_CHANGE_NKEY",
        ]) {
            expect(name in mod).toBe(false);
        }
    });
});
