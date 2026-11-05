import { expect, it } from "vitest";
import { creditV1, fundsV1 } from "./payload";

it("encodes only payload version and memo bytes, preserving every leading memo byte", () => {
    for (const memo of [
        new Uint8Array(),
        new Uint8Array([0, 1, 2, 255, 128]),
        new Uint8Array(256).fill(1),
    ]) {
        const expected = new Uint8Array([1, ...memo]);
        for (const codec of [fundsV1, creditV1]) {
            const encoded = codec.encode({ memo });
            expect(encoded).toEqual(expected);
            const decoded = codec.decode(encoded);
            expect(decoded.memo ?? new Uint8Array()).toEqual(memo);
            if (decoded.memo) decoded.memo.fill(9);
            expect(codec.decode(encoded).memo ?? new Uint8Array()).toEqual(memo);
        }
    }
    expect(fundsV1.encode()).toEqual(new Uint8Array([1]));
});
it("rejects unsupported versions, oversized memos and removed built-in metadata fields", () => {
    for (const codec of [fundsV1, creditV1]) {
        for (const bytes of [[], [0], [2, 0], [1, ...new Uint8Array(257)]]) {
            expect(() => codec.decode(new Uint8Array(bytes))).toThrow();
        }
        expect(() => codec.encode({ memo: new Uint8Array(257) })).toThrow();
        expect(() =>
            codec.encode({ returnAddress: "application-defined" } as unknown as { memo?: string })
        ).toThrow(/unsupported/);
        expect(() => codec.encode({ flags: 1 } as unknown as { memo?: string })).toThrow(
            /unsupported/
        );
    }
});
