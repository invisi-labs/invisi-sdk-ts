import type { WalletState } from "./state";
import type { WalletRecordCodec } from "./store";
// Tagged nodes avoid collisions between application strings/objects and BigInt encodings.
function encode(value: unknown): unknown {
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (value instanceof Uint8Array) return ["bytes", Array.from(value)];
    if (Array.isArray(value)) return ["array", value.map(encode)];
    if (value && typeof value === "object")
        return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
    if (value === undefined) return ["undefined"];
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    )
        return ["value", value];
    throw new Error("unsupported wallet record value");
}
function decode(node: unknown): unknown {
    if (!Array.isArray(node)) throw new Error("invalid wallet record encoding");
    const [type, value] = node;
    if (type === "bigint" && typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value))
        return BigInt(value);
    if (
        type === "bytes" &&
        Array.isArray(value) &&
        value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)
    )
        return Uint8Array.from(value);
    if (type === "array" && Array.isArray(value)) return value.map(decode);
    if (type === "object" && Array.isArray(value))
        return Object.fromEntries(
            value.map((pair) => {
                if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string")
                    throw new Error("invalid object record");
                return [pair[0], decode(pair[1])];
            })
        );
    if (type === "undefined" && node.length === 1) return undefined;
    if (
        type === "value" &&
        (value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)))
    )
        return value;
    throw new Error("invalid wallet record node");
}
export function serializeState(state: WalletState): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(encode(state)));
}
export function deserializeState(data: Uint8Array): WalletState {
    const state = decode(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))
    ) as WalletState;
    if (state.schemaVersion !== 2) throw Error("Unsupported wallet store schema");
    return state;
}
/** Only for explicitly nonpersistent reference storage. Persistent adapters require a caller-selected codec. */
export class MemoryRecordCodec implements WalletRecordCodec {
    async encode(state: WalletState) {
        return serializeState(state);
    }
    async decode(data: Uint8Array) {
        return deserializeState(data);
    }
}
