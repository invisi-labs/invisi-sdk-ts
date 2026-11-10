import type { CreditDataV1, FundsDataV1 } from "../types";
import { encodeMemo } from "./memo";

function encodeData(data: unknown): Uint8Array {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new TypeError("v1 payload data must be an object");
    }
    for (const key of Object.keys(data)) {
        if (key !== "memo") throw new Error(`unsupported v1 payload field ${key}`);
    }
    const memo = encodeMemo((data as FundsDataV1).memo);
    return new Uint8Array([1, ...memo]);
}
function readData(value: Uint8Array): { memo?: Uint8Array } {
    if (!(value instanceof Uint8Array) || value.length < 1) {
        throw new Error("payload version required");
    }
    if (value[0] !== 1) throw new Error("unsupported payload version");
    const memo = Uint8Array.from(value.subarray(1));
    if (memo.length > 256) throw new Error("invalid memo length");
    return memo.length === 0 ? {} : { memo };
}
/** Pure memo codec: payload version1 followed by memo bytes; no flags or address semantics. */
export const fundsV1 = Object.freeze({
    encode(data: FundsDataV1 = {}): Uint8Array {
        return encodeData(data);
    },
    decode(value: Uint8Array): { memo?: Uint8Array } {
        return readData(value);
    },
});
/** Credit uses the same memo-only application layout, independently of its financial fields. */
export const creditV1 = Object.freeze({
    encode(data: CreditDataV1 = {}): Uint8Array {
        return encodeData(data);
    },
    decode(value: Uint8Array): { memo?: Uint8Array } {
        return readData(value);
    },
});
