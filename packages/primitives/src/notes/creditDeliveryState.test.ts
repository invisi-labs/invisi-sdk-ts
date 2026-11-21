import { it, expect } from "vitest";
import { deliveryCodec } from "../delivery/delivery-codec";
it("keeps deferred Credit delivery separate from Note delivery", () => {
    expect(deliveryCodec(0x84)).toMatchObject({
        kind: "credit",
        version: 4,
        minimum: 491,
        maximum: 4096,
        domain: "Invisi.CreditDelivery.v4.GrantId.Uint128",
    });
    expect(deliveryCodec(0x01)).toMatchObject({ kind: "funds", version: 1, minimum: 160 });
    expect(() => deliveryCodec(0x81)).toThrow();
});
