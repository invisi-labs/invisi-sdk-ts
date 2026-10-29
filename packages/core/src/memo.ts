/** Optional encrypted output metadata; never part of a financial commitment. */
export type Memo = string | Uint8Array;
export const MAX_MEMO_BYTES = 256;
declare const TextEncoder: { new (): { encode(value: string): Uint8Array } };
declare const TextDecoder: {
    new (
        label: string,
        options: { fatal: boolean; ignoreBOM: boolean }
    ): { decode(value: Uint8Array): string };
};
/** Encode text strictly as UTF-8, or copy opaque bytes, with a 256-byte limit. */
export function encodeMemo(memo?: Memo): Uint8Array {
    if (memo === undefined) return new Uint8Array();
    let encoded: Uint8Array;
    if (typeof memo === "string") {
        for (let i = 0; i < memo.length; i++) {
            const unit = memo.charCodeAt(i);
            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = memo.charCodeAt(++i);
                if (!(next >= 0xdc00 && next <= 0xdfff))
                    throw new Error("memo contains an invalid surrogate");
            } else if (unit >= 0xdc00 && unit <= 0xdfff)
                throw new Error("memo contains an invalid surrogate");
        }
        encoded = new TextEncoder().encode(memo);
    } else if (memo instanceof Uint8Array) encoded = Uint8Array.from(memo);
    else throw new TypeError("memo must be text or Uint8Array");
    if (encoded.length > MAX_MEMO_BYTES) throw new RangeError("memo exceeds 256 bytes");
    return encoded;
}
/** Explicit strict UTF-8 decoding; opaque bytes remain valid even when decoding fails. */
export function decodeMemoText(memo: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(memo);
}
