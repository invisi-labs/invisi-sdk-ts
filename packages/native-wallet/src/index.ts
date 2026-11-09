import {
    validateWalletBatch,
    validateWalletResponses,
    MAX_WALLET_BATCH_BYTES,
    type NativeWalletClient,
    type WalletResponse,
} from "@invisi-labs/core";
export { NativeWalletError } from "@invisi-labs/core";

/** Implemented by a host native module or FFI binding; this package never receives keys. */
export interface NativeWalletTransport {
    executeWalletRequests(requests: string): Promise<string>;
}

export function createNativeWalletClient(transport: NativeWalletTransport): NativeWalletClient {
    return Object.freeze({
        async execute(requests) {
            const retained = structuredClone(requests);
            validateWalletBatch(retained);
            if (retained.length === 0) return [];
            const json = await transport.executeWalletRequests(JSON.stringify(retained));
            if (
                typeof json !== "string" ||
                new TextEncoder().encode(json).length > MAX_WALLET_BATCH_BYTES
            )
                throw new Error("invalid native wallet response size");
            return validateWalletResponses(retained, JSON.parse(json) as WalletResponse[]);
        },
    } satisfies NativeWalletClient);
}
