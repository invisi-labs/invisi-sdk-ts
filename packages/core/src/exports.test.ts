import { expect, it } from "vitest";

it("provides current Note, Credit and wallet capability primitives", async () => {
    const api = await import("./index");
    for (const name of [
        "computeNoteIdentity",
        "computeNoteCommitment",
        "computeCreditCommitment",
        "recoverCreditState",
        "Wallet",
        "ViewingCapability",
        "Detector",
        "Disclosure",
    ] as const)
        expect(typeof api[name]).toBe("function");
    expect("fromPrivateKey" in api.Wallet).toBe(false);
    expect(typeof api.Wallet.fromAddress).toBe("function");
});
