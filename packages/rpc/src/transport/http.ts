import { ProtocolRpcConnectionOptions } from "../client/options";
import { invalid, ProtocolRpcError } from "./errors";

export function endpoint(options: ProtocolRpcConnectionOptions): URL {
    let url: URL;
    try {
        url = new URL(options.url);
    } catch {
        return invalid("Invalid RPC URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") invalid("RPC URL must use HTTP(S)");
    if (url.username || url.password || url.hash)
        invalid("RPC URL must not contain credentials or fragments");
    if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    )
        invalid("Invalid RPC timeout");
    return url;
}

export async function requestJson(
    options: ProtocolRpcConnectionOptions,
    init: RequestInit,
    signal?: AbortSignal
): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? 30_000);
    try {
        if (controller.signal.aborted) throw new ProtocolRpcError("RPC request aborted", "aborted");
        const response = await (options.fetch ?? globalThis.fetch)(options.url, {
            ...init,
            headers: {
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            },
            signal: controller.signal,
        });
        if (!response.ok)
            throw new ProtocolRpcError("RPC HTTP request failed", "http", response.status);
        return await response.json();
    } catch (error) {
        if (timedOut) throw new ProtocolRpcError("RPC request timed out", "timeout");
        if (controller.signal.aborted) throw new ProtocolRpcError("RPC request aborted", "aborted");
        if (error instanceof ProtocolRpcError) throw error;
        throw new ProtocolRpcError("RPC transport or JSON decoding failed", "transport");
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}
