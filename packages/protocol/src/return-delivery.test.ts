import { expect, it } from "vitest";
import { normalizeDelivery, normalizeOpaqueDelivery } from "./validation";
const clue = ("0x" + "00".repeat(64) + "18" + "00".repeat(3)) as `0x${string}`;
function delivery(version: number, length: number) {
    return {
        ciphertext: ("0x" +
            version.toString(16).padStart(2, "0") +
            "00".repeat(length - 1)) as `0x${string}`,
        clue,
    };
}
it("accepts current return-address delivery boundaries without changing Credit format", () => {
    for (const [version, sizes] of [[1, [161, 246, 417, 502]]] as const) {
        for (const length of sizes)
            expect(normalizeDelivery(delivery(version, length))).toEqual(delivery(version, length));
    }
    expect(normalizeDelivery(delivery(129, 754), { credit: true })).toEqual(delivery(129, 754));
    for (const [version, length] of [
        [2, 160],
        [2, 417],
        [1, 160],
        [1, 503],
        [7, 246],
        [5, 498],
    ]) {
        expect(() => normalizeDelivery(delivery(version!, length!))).toThrow();
    }
    expect(() => normalizeDelivery(delivery(1, 502), { credit: true })).toThrow();
});

it("preserves unknown codec ciphertext in transport while builders reject unsupported codecs", () => {
    for (const length of [1, 4096]) {
        const value = delivery(127, length);
        expect(normalizeOpaqueDelivery(value)).toEqual(value);
        expect(() => normalizeDelivery(value)).toThrow(/version/);
    }
    expect(() => normalizeOpaqueDelivery(delivery(127, 4097))).toThrow();
    expect(() => normalizeOpaqueDelivery({ ciphertext: "0x", clue })).toThrow();
});
