import { expect, it } from "vitest";

it("provides current Note, Credit and wallet capability primitives", async () => {
    const api = await import("./index");
    for (const name of [
        "computeNoteIdentity",
        "computeNoteCommitment",
        "computeCreditCommitment",
        "recoverCreditState",
        "Wallet",
        "PublicWallet",
        "ViewingCapability",
        "Detector",
        "Disclosure",
    ] as const)
        expect(typeof api[name]).toBe("function");
    expect(typeof api.Wallet.fromPrivateKey).toBe("function");
    expect(typeof api.PublicWallet.fromAddress).toBe("function");
});
