import type { WalletRequestProvider, WalletResponse } from "@invisi-labs/core";

/** Implemented by a host native module or FFI binding; this package never receives keys. */
export interface NativeWalletTransport {
    executeWalletRequest(request: string): Promise<string>;
}

export class NativeWalletError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = "NativeWalletError";
    }
}

/** Adapt a native JSON bridge. The SDK validates method-specific results on acceptance. */
export function createNativeWalletProvider(
    transport: NativeWalletTransport
): WalletRequestProvider {
    return Object.freeze({
        async execute(request) {
            const retained = structuredClone(request);
            const json = await transport.executeWalletRequest(JSON.stringify(retained));
            if (typeof json !== "string" || json.length > 1_048_576)
                throw new Error("invalid native wallet response size");
            const response = JSON.parse(json) as WalletResponse;
            if (response && typeof response === "object" && "error" in response) {
                const code = (response.error as { code?: unknown } | null)?.code;
                if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
                    throw new Error("invalid native wallet error");
                }
                throw new NativeWalletError(code);
            }
            if (
                !response ||
                response.version !== retained.version ||
                response.id !== retained.id ||
                response.ownerAddress !== retained.ownerAddress ||
                response.method !== retained.method ||
                !("result" in response)
            )
                throw new Error("native wallet response envelope mismatch");
            return response;
        },
    } satisfies WalletRequestProvider);
}
