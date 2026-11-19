import { expect, it } from "vitest";
import { initialPaymentProofsEnabled } from "./resource-options";
it("requires combined real proofs by default and fails closed on a CI skip", () => {
    expect(initialPaymentProofsEnabled({})).toBe(true);
    expect(initialPaymentProofsEnabled({ CI: "true" })).toBe(true);
    expect(initialPaymentProofsEnabled({ INVISI_SKIP_INITIAL_PAYMENT_PROOFS: "1" })).toBe(false);
    expect(() =>
        initialPaymentProofsEnabled({ CI: "true", INVISI_SKIP_INITIAL_PAYMENT_PROOFS: "1" })
    ).toThrow(/CI must run/);
});

it("fails closed when the independent initial-payment index is absent", async () => {
    const { loadCircuitBrowser } = await import("../circuits/circuits-browser");
    const { INITIAL_PAYMENT_ASSET_INDEX_SHA256 } = await import("../resources/pin");
    const requested: string[] = [];
    await expect(
        loadCircuitBrowser("create_credit_initial_payment", {
            offline: true,
            cache: {
                async get(key) {
                    requested.push(key);
                    return undefined;
                },
                async put() {},
            },
        })
    ).rejects.toThrow(/unavailable offline/);
    expect(requested).toEqual([`${INITIAL_PAYMENT_ASSET_INDEX_SHA256}.index.json`]);
});
