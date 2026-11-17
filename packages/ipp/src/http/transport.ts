import { IppError, invalid } from "../core/errors";
import { readIppResponse } from "../core/json";
import { apiUrl, assertNoSecret, bearer, object, text } from "../core/values";

export interface HttpOptions {
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
}
export function duration(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) return invalid();
    return value;
}
export function aborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new IppError("aborted", "IPP operation aborted.");
}
export function retryAfter(value: string | null): number | undefined {
    if (value === null) return undefined;
    const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(ms) ? Math.min(2147483647, Math.max(0, ms)) : undefined;
}
export async function sendIpp(
    options: HttpOptions,
    url: string,
    token: string,
    method: "GET" | "POST",
    body: unknown,
    key: string | undefined,
    signal: AbortSignal | undefined,
    statuses: number[]
): Promise<{ value: unknown; response: Response }> {
    apiUrl(url);
    bearer(token);
    assertNoSecret(url, token);
    aborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, duration(options.requestTimeoutMs ?? 15000));
    try {
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key !== undefined) headers["Idempotency-Key"] = key;
        const response = await (options.fetch ?? globalThis.fetch)(url, {
            method,
            headers,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (
            response.redirected ||
            (response.url && response.url !== url) ||
            (response.status >= 300 && response.status < 400)
        )
            return invalid();
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? ""))
            return invalid();
        const value = await readIppResponse(response);
        if (!response.ok) {
            const e = object(value, ["ippVersion", "type", "error"]);
            const details = object(e.error, ["code", "message", "retryable"]);
            if (
                e.ippVersion !== 1 ||
                e.type !== "error" ||
                typeof details.retryable !== "boolean" ||
                !/^[a-z][a-z0-9_]{0,63}$/.test(text(details.code))
            )
                return invalid();
            text(details.message);
            throw new IppError(
                details.code as string,
                "IPP request failed.",
                details.retryable,
                response.status,
                retryAfter(response.headers.get("Retry-After"))
            );
        }
        if (!statuses.includes(response.status)) return invalid();
        return { value, response };
    } catch (error) {
        if (error instanceof IppError) throw error;
        if (signal?.aborted) throw new IppError("aborted", "IPP operation aborted.");
        throw new IppError(
            "transport_error",
            "IPP transport failed; recover the original operation before retrying.",
            true
        );
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
    aborted(signal);
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new IppError("aborted", "IPP operation aborted."));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
export function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
            .join(",")}}`;
    return JSON.stringify(value) ?? "null";
}
