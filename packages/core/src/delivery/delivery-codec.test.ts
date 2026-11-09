import { expect, it } from "vitest";
import { deliveryCodec, deliveryHeader } from "./delivery-codec";

it("separates the high type bit from the seven version bits", () => {
    expect(deliveryCodec(0x01)).toMatchObject({ kind: "funds", version: 1 });
    expect(deliveryCodec(0x82)).toMatchObject({ kind: "credit", version: 2 });
    expect(deliveryHeader("funds")).toBe(0x01);
    expect(deliveryHeader("credit")).toBe(0x82);
});
it("rejects zero, unknown versions and non-byte headers ", () => {
    for (const header of [0, 128, 2, 129, 5, 6, -1, 256, 1.5, NaN]) {
        expect(() => deliveryCodec(header)).toThrow();
    }
});
