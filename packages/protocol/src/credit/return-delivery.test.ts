import { expect, it } from "vitest";
import { normalizeOpaqueDelivery } from "../validation";
const clue = ("0x" + "00".repeat(64) + "18" + "00".repeat(3)) as `0x${string}`;
function delivery(header: number, length: number) {
    return {
        ciphertext: ("0x" +
            header.toString(16).padStart(2, "0") +
            "00".repeat(length - 1)) as `0x${string}`,
        clue,
    };
}
it("preserves opaque current, custom and unsupported codec envelopes", () => {
    for (const [header, length] of [
        [1, 161],
        [129, 498],
        [2, 200],
        [130, 600],
        [127, 1],
        [255, 4096],
    ]) {
        const value = delivery(header!, length!);
        expect(normalizeOpaqueDelivery(value)).toEqual(value);
    }
});
it("rejects only malformed transport, oversized ciphertexts and invalid clues", () => {
    expect(() => normalizeOpaqueDelivery(delivery(127, 4097))).toThrow();
    expect(() => normalizeOpaqueDelivery({ ciphertext: "0x", clue })).toThrow();
    expect(() => normalizeOpaqueDelivery({ ...delivery(2, 200), clue: "0x" })).toThrow();
});

it("allows both delivery fields empty only when explicitly allowed for funds", () => {
    const empty = { ciphertext: "0x", clue: "0x" } as const;
    expect(normalizeOpaqueDelivery(empty, { allowEmpty: true })).toEqual(empty);
    expect(() => normalizeOpaqueDelivery(empty)).toThrow();
    expect(() =>
        normalizeOpaqueDelivery({ ciphertext: "0x", clue }, { allowEmpty: true })
    ).toThrow();
    expect(() =>
        normalizeOpaqueDelivery({ ciphertext: "0x01", clue: "0x" }, { allowEmpty: true })
    ).toThrow();
});
