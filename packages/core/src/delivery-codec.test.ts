import { expect, it } from "vitest";
import { deliveryCodec, deliveryHeader } from "./delivery-codec";

it("separates the high type bit from the seven version bits", () => {
    expect(deliveryCodec(0x01)).toMatchObject({ type: 0, kind: "funds", version: 1 });
    expect(deliveryCodec(0x81)).toMatchObject({ type: 1, kind: "credit", version: 1 });
    expect(deliveryHeader("funds", 1)).toBe(0x01);
    expect(deliveryHeader("credit", 1)).toBe(0x81);
    expect(deliveryHeader("funds", 127)).toBe(0x7f);
    expect(deliveryHeader("credit", 127)).toBe(0xff);
});
it("rejects zero, unknown versions and non-byte headers without compatibility fallbacks", () => {
    for (const header of [0, 128, 2, 130, 5, 6, -1, 256, 1.5, NaN]) {
        expect(() => deliveryCodec(header)).toThrow();
    }
    for (const version of [0, 128, -1, 1.5, NaN]) {
        expect(() => deliveryHeader("funds", version)).toThrow();
    }
});
