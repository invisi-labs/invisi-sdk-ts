import { it, expect } from "vitest";
import { deliveryCodec } from "../delivery/delivery-codec";
it("keeps deferred Credit delivery separate from Note delivery", () => {
    expect(deliveryCodec(0x82)).toMatchObject({
        kind: "credit",
        version: 2,
        minimum: 485,
        maximum: 4096,
        domain: "Invisi.CreditDelivery.v2",
    });
    expect(deliveryCodec(0x01)).toMatchObject({ kind: "funds", version: 1, minimum: 160 });
    expect(() => deliveryCodec(0x81)).toThrow();
});
