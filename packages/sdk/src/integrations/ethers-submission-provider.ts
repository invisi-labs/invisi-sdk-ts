import { AbstractProvider, BrowserProvider, JsonRpcProvider, Network } from "ethers/providers";
import { type JsonRpcApiProvider, type PerformActionRequest } from "ethers";
import { toQuantity } from "ethers/utils";
import type { CanonicalBlock } from "@invisi-labs/protocol";

export interface SubmissionNetworkGuard {
    assertUnchanged(): void;
    close(): void;
}

/** A raw EIP-1193 source captured by the reader factory, never an unrelated event bus. */
export function watchSubmissionNetwork(
    source?: object,
    invalidate?: () => void
): SubmissionNetworkGuard | undefined {
    if (!source) return;
    const on = Reflect.get(source, "on");
    const remove = Reflect.get(source, "removeListener");
    if (typeof on !== "function" || typeof remove !== "function") return;
    let closed = false;
    let failure: Error | undefined;
    const changed = () => {
        if (!closed) {
            failure ??= Error("submission network changed during validation");
            invalidate?.();
        }
    };
    const disconnected = () => {
        if (!closed) {
            failure ??= Error("submission network disconnected during validation");
            invalidate?.();
        }
    };
    const close = () => {
        if (closed) return;
        closed = true;
        try {
            remove.call(source, "chainChanged", changed);
        } finally {
            remove.call(source, "disconnect", disconnected);
        }
    };
    try {
        on.call(source, "chainChanged", changed);
        on.call(source, "disconnect", disconnected);
    } catch (error) {
        close();
        throw error;
    }
    return {
        assertUnchanged() {
            if (closed) throw Error("submission network guard closed");
            if (failure) throw failure;
        },
        close,
    };
}

export class UnsupportedSubmissionHash extends Error {
    constructor() {
        super("provider does not support hash-pinned submission reads");
    }
}

export const submissionProviderMethods = [
    "getNetwork",
    "getBlock",
    "getCode",
    "call",
    "getRpcRequest",
    "_perform",
    "send",
    "_send",
    "_getAddress",
    "_getBlockTag",
    "_getTransactionRequest",
] as const;

/** Only concrete, unmodified transports opt in; custom provider policies keep their original path. */
export function submissionRpcProvider(provider: AbstractProvider): JsonRpcApiProvider | undefined {
    if (
        ![BrowserProvider.prototype, JsonRpcProvider.prototype].includes(
            Object.getPrototypeOf(provider)
        )
    )
        return;
    if (provider._requestRate !== null) return;
    for (const method of submissionProviderMethods) {
        if (Object.hasOwn(provider, method)) return;
    }
    return provider as JsonRpcApiProvider;
}

/** A finite, read-only context. It never mutates or destroys the shared provider. */
export class SubmissionReadProvider extends AbstractProvider {
    #closed = false;
    #head?: CanonicalBlock;
    constructor(
        readonly original: JsonRpcApiProvider,
        readonly expectedChainId: bigint,
        private readonly networkGuard?: SubmissionNetworkGuard
    ) {
        super(expectedChainId, { cacheTimeout: -1 });
    }
    assertOpen() {
        if (this.#closed) throw Error("submission read scope closed");
        this.networkGuard?.assertUnchanged();
    }
    pin(head: CanonicalBlock) {
        this.assertOpen();
        this.#head = head;
    }
    async checkNetwork() {
        this.assertOpen();
        if ((await this.original.getNetwork()).chainId !== this.expectedChainId)
            throw Error("submission provider chain mismatch");
        this.assertOpen();
    }
    async _detectNetwork() {
        this.assertOpen();
        return Network.from(this.expectedChainId);
    }
    async _perform<T = unknown>(request: PerformActionRequest): Promise<T> {
        this.assertOpen();
        if (
            request.method !== "getBlock" &&
            request.method !== "getCode" &&
            request.method !== "call"
        )
            throw Error("submission scope permits only pinned reads");
        const read = async () => {
            if (request.method === "getBlock") return this.original._perform(request);
            const head = this.#head;
            if (
                !head ||
                (request.blockTag !== "latest" && request.blockTag !== toQuantity(head.number))
            )
                throw Error("submission read block mismatch");
            const rpc = this.original.getRpcRequest(request);
            if (!rpc || !["eth_getCode", "eth_call"].includes(rpc.method))
                throw Error("unsupported submission read");
            const params = [...rpc.args];
            params[params.length - 1] = { blockHash: head.hash, requireCanonical: true };
            try {
                return await this.original.send(rpc.method, params);
            } catch (error) {
                const e = error as {
                    code?: unknown;
                    error?: { code?: unknown };
                    info?: { error?: { code?: unknown } };
                };
                const code = e.info?.error?.code ?? e.error?.code ?? e.code;
                // Only explicit unsupported request forms restart the original full gate.
                if (code === -32601 || code === -32602) throw new UnsupportedSubmissionHash();
                throw error;
            }
        };
        try {
            // Captured raw events make switching away and back a terminal refusal.
            // Without that guarantee retain the original per-phase network checks.
            const [value] = await Promise.all([
                read(),
                this.#head && !this.networkGuard ? this.checkNetwork() : Promise.resolve(),
            ]);
            this.assertOpen();
            return value as T;
        } catch (error) {
            // A network event takes precedence over unsupported-hash fallback.
            this.assertOpen();
            throw error;
        }
    }
    close() {
        if (!this.#closed) {
            this.#closed = true;
            try {
                this.networkGuard?.close();
            } finally {
                super.destroy();
            }
        }
    }
}
