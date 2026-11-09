import { it, expect } from "vitest";
import { getDocumentedGasReference } from "@invisi-labs/sdk";
import { fixture } from "../../../../test-support/operation-fixture";
import { testOutput } from "../../../../test-support/test-output";
it("keeps documented pre-proof references distinct from final RPC estimation", async () => {
    const h = await fixture(),
        prepared = await h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
    expect(prepared.getGasReference().source).toBe("documented-reference");
    await expect(prepared.estimateGas()).rejects.toThrow(/provider/);
});
it("returns documented revoke medians only for an exact authorization and bitmap scenario", () => {
    expect(
        getDocumentedGasReference({
            kind: "revoke-credit",
            authorization: "direct",
            bitmapWord: "empty",
        })
    ).toMatchObject({ available: false });
    expect(getDocumentedGasReference({ kind: "aggregate" })).toMatchObject({ available: false });
    expect(
        getDocumentedGasReference({ kind: "draw-credit", creditInputs: 2, distinctPayers: 1 })
    ).toMatchObject({ available: false });
});
