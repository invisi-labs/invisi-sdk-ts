import { invalid } from "./errors";

export type ObjectValue = Record<string, unknown>;
export function record(value: unknown): ObjectValue {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
    return value as ObjectValue;
}

export function object(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = []
): ObjectValue {
    const obj = record(value);
    if (
        required.some((key) => !Object.hasOwn(obj, key)) ||
        Object.keys(obj).some((key) => !required.includes(key) && !optional.includes(key))
    )
        return invalid();
    return obj;
}

export function text(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 8192 ||
        /[\u0000-\u001f\u007f]/.test(value)
    )
        return invalid();
    for (let i = 0; i < value.length; i++) {
        const n = value.charCodeAt(i);
        if (n >= 0xd800 && n <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
        } else if (n >= 0xdc00 && n <= 0xdfff) return invalid();
    }
    return value;
}

export function integer(value: unknown, bits: number, positive = false): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 80)
        return invalid();
    const n = BigInt(value);
    if (n >= 1n << BigInt(bits) || (positive && n === 0n)) return invalid();
    return n;
}

export function number(value: unknown, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
        return invalid();
    return value;
}

export function timestamp(value: unknown): number {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
        return invalid();
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== value)
        return invalid();
    return ms;
}

export function hex(value: unknown, bytes: number, nonzero = false): string {
    if (
        typeof value !== "string" ||
        !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value) ||
        (nonzero && BigInt(value) === 0n)
    )
        return invalid();
    return value;
}

export function apiUrl(value: unknown, origin?: string): string {
    const s = text(value);
    let url: URL;
    try {
        decodeURI(s);
        url = new URL(s);
    } catch {
        return invalid();
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.href !== s ||
        /[^\x21-\x7e]/.test(s) ||
        (origin && url.origin !== origin)
    )
        return invalid();
    for (const key of url.searchParams.keys())
        if (/token|secret|key|opening|credential|authorization/i.test(key)) return invalid();
    return s;
}

export function link(value: unknown, method: "GET" | "POST", origin?: string): void {
    const l = object(value, ["href", "method"]);
    if (l.method !== method) return invalid();
    apiUrl(l.href, origin);
}

export function header(obj: ObjectValue, type: string): void {
    if (obj.ippVersion !== 1 || obj.type !== type) return invalid();
}

export function mode(value: unknown): asserts value is "payment" | "credit" {
    if (value !== "payment" && value !== "credit") return invalid();
}

export function status(obj: ObjectValue, allowOpen = false): void {
    if (
        ![
            "requires_action",
            "processing",
            "succeeded",
            "failed",
            ...(allowOpen ? ["open"] : []),
        ].includes(obj.status as string)
    )
        return invalid();
    if (
        obj.status === "failed"
            ? !["expired", "closed"].includes(obj.failureReason as string)
            : obj.failureReason !== null
    )
        return invalid();
}

export function assertNoSecret(url: string, secret: string): void {
    const parsed = new URL(apiUrl(url));
    const route = `${parsed.pathname}${parsed.search}`;
    if (route.includes(secret) || decodeURIComponent(route).includes(secret)) return invalid();
}

export function bearer(value: unknown): string {
    const s = text(value);
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(s)) return invalid();
    return s;
}

export function idempotencyKey(value: unknown): string {
    const s = text(value);
    if (!/^[\x21-\x7e]{1,128}$/.test(s)) return invalid();
    return s;
}
