import { expect, it } from "vitest";
import { deliveryCodec, deliveryHeader } from "./delivery-codec";

it("separates the high type bit from the seven version bits", () => {
    expect(deliveryCodec(0x01)).toMatchObject({ kind: "funds", version: 1 });
    expect(deliveryCodec(0x81)).toMatchObject({ kind: "credit", version: 1 });
    expect(deliveryHeader("funds")).toBe(0x01);
    expect(deliveryHeader("credit")).toBe(0x81);
});
it("rejects zero, unknown versions and non-byte headers without compatibility fallbacks", () => {
    for (const header of [0, 128, 2, 130, 5, 6, -1, 256, 1.5, NaN]) {
        expect(() => deliveryCodec(header)).toThrow();
    }
});
