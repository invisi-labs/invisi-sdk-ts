import { PROVER_ASSET_INDEX_SHA256 } from "./pin";
export interface ResourceCache {
    get(
        key: string,
        options?: { maxBytes: number; signal: AbortSignal }
    ): Promise<Uint8Array | undefined>;
    put(key: string, value: Uint8Array): Promise<void>;
}
export interface ResourceOptions {
    baseUrls?: readonly string[];
    offline?: boolean;
    timeoutMs?: number;
    fetch?: typeof globalThis.fetch;
    cache?: ResourceCache;
}
interface Entry {
    sha256: string;
    size: number;
}
interface Index {
    format: string;
    noirVersion: string;
    bbVersion: string;
    files: Record<string, Entry>;
}
interface Flight {
    promise: Promise<Uint8Array>;
    controller: AbortController;
    users: number;
}
const MAX_ASSET = 64 * 1024 * 1024;
const MAX_INDEX = 2 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
export function resourcePath(path: string): string {
    if (
        !/^(?:circuits|provenance)\/[A-Za-z0-9_./-]+$/.test(path) ||
        path.split("/").some((p) => !p || p === "." || p === "..")
    )
        throw new Error("Invalid prover resource path");
    return path;
}
export function resourceObject(path: string, hash: string): string {
    return `${hash}.${path.endsWith(".json") ? "json" : "vk"}`;
}
export async function resourceHash(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join(
        ""
    );
}
function parseIndex(bytes: Uint8Array): Index {
    const index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Index;
    if (
        index.format !== "invisi.prover-assets.v1" ||
        index.noirVersion !== "1.0.0" ||
        index.bbVersion !== "6.0.0" ||
        !index.files ||
        typeof index.files !== "object" ||
        Array.isArray(index.files)
    )
        throw new Error("Unsupported prover resource index");
    for (const [path, entry] of Object.entries(index.files)) {
        resourcePath(path);
        if (
            !entry ||
            !hashPattern.test(entry.sha256) ||
            !Number.isSafeInteger(entry.size) ||
            entry.size <= 0 ||
            entry.size > MAX_ASSET
        )
            throw new Error("Invalid prover resource entry");
    }
    return index;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort = () => {};
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                abort = () => reject(new Error("Resource load interrupted"));
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            }),
        ]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
/** Downloads public, pinned bytes only. No witness or transaction data enters this boundary. */
export class ResourceLoader {
    readonly #options: ResourceOptions;
    readonly #pin: string;
    readonly #flights = new Map<string, Flight>();
    readonly #memory = new Map<string, Uint8Array>();
    readonly #bases: string[];
    constructor(options: ResourceOptions = {}, pin = PROVER_ASSET_INDEX_SHA256) {
        if (!hashPattern.test(pin)) throw new Error("Invalid prover resource pin");
        const timeout = options.timeoutMs ?? 60_000;
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
            throw new Error("Invalid resource timeout");
        this.#options = { ...options, timeoutMs: timeout };
        this.#pin = pin;
        this.#bases = [
            ...(options.baseUrls ?? [`https://assets.invisipay.fi/prover/sets/${pin}/`]),
        ].map((base) => {
            const url = new URL(base);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid prover resource source");
            return base.endsWith("/") ? base : base + "/";
        });
    }
    async load(path: string, signal?: AbortSignal): Promise<Uint8Array> {
        resourcePath(path);
        signal?.throwIfAborted();
        const index = parseIndex(
            await this.#shared(
                `${this.#pin}.index.json`,
                this.#pin,
                undefined,
                MAX_INDEX,
                "index.json",
                signal
            )
        );
        const entry = index.files[path];
        if (!entry) throw new Error("Resource is not in the pinned release");
        return this.#shared(
            resourceObject(path, entry.sha256),
            entry.sha256,
            entry.size,
            entry.size,
            resourceObject(path, entry.sha256),
            signal
        );
    }
    async #shared(
        key: string,
        hash: string,
        size: number | undefined,
        max: number,
        remote: string,
        signal?: AbortSignal
    ): Promise<Uint8Array> {
        signal?.throwIfAborted();
        let flight = this.#flights.get(key);
        if (!flight) {
            const controller = new AbortController();
            flight = { controller, users: 0, promise: undefined! };
            const current = flight;
            const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
            flight.promise = abortable(
                this.#read(key, hash, size, max, remote, controller.signal),
                controller.signal
            ).finally(() => {
                clearTimeout(timer);
                if (this.#flights.get(key) === current) this.#flights.delete(key);
            });
            this.#flights.set(key, flight);
        }
        flight.users++;
        let abort: () => void = () => {};
        try {
            const cancelled = new Promise<never>((_, reject) => {
                abort = () => reject(signal?.reason ?? new Error("Resource load cancelled"));
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
            });
            return (await Promise.race([flight.promise, cancelled])).slice();
        } finally {
            signal?.removeEventListener("abort", abort);
            if (--flight.users === 0) {
                flight.controller.abort();
                if (this.#flights.get(key) === flight) this.#flights.delete(key);
            }
        }
    }
    async #valid(
        bytes: Uint8Array | undefined,
        hash: string,
        size: number | undefined,
        max: number
    ): Promise<boolean> {
        return (
            !!bytes &&
            bytes.length <= max &&
            (size === undefined || bytes.length === size) &&
            (await resourceHash(bytes)) === hash
        );
    }
    async #read(
        key: string,
        hash: string,
        size: number | undefined,
        max: number,
        remote: string,
        signal: AbortSignal
    ): Promise<Uint8Array> {
        const memory = this.#memory.get(key);
        if (await this.#valid(memory, hash, size, max)) return memory!;
        let cached: Uint8Array | undefined;
        try {
            cached = await abortable(
                Promise.resolve(this.#options.cache?.get(key, { maxBytes: max, signal })),
                signal
            );
        } catch {
            /* Cache failure is not an integrity decision. */
        }
        signal.throwIfAborted();
        if (await this.#valid(cached, hash, size, max)) {
            this.#memory.set(key, cached!.slice());
            return cached!;
        }
        if (this.#options.offline) throw new Error("Pinned prover resource is unavailable offline");
        for (const base of this.#bases) {
            signal.throwIfAborted();
            const controller = new AbortController(),
                abort = () => controller.abort(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
            try {
                const response = await abortable(
                    (this.#options.fetch ?? globalThis.fetch)(new URL(remote, base), {
                        signal: controller.signal,
                        credentials: "omit",
                        referrerPolicy: "no-referrer",
                        redirect: "follow",
                    }),
                    controller.signal
                );
                if (!response.ok || (response.url && new URL(response.url).protocol !== "https:"))
                    throw new Error("Resource download failed");
                const length = response.headers.get("Content-Length");
                if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
                    throw new Error("Resource response exceeds limit");
                const reader = response.body?.getReader();
                if (!reader) throw new Error("Empty resource response");
                const chunks: Uint8Array[] = [];
                let total = 0;
                const read = async () => {
                    try {
                        while (true) {
                            controller.signal.throwIfAborted();
                            const item = await reader.read();
                            if (item.done) break;
                            total += item.value.length;
                            if (total > max) throw new Error("Resource response exceeds limit");
                            chunks.push(item.value);
                        }
                    } finally {
                        void reader.cancel().catch(() => {});
                    }
                };
                let cancel: () => void = () => {};
                try {
                    await Promise.race([
                        read(),
                        new Promise<never>((_, reject) => {
                            cancel = () => reject(new Error("Resource download interrupted"));
                            controller.signal.addEventListener("abort", cancel, { once: true });
                            if (controller.signal.aborted) cancel();
                        }),
                    ]);
                } finally {
                    controller.signal.removeEventListener("abort", cancel);
                }
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                if (!(await this.#valid(bytes, hash, size, max)))
                    throw new Error("Resource integrity mismatch");
                // A trusted digest is required before either memory or persistent caching.
                if (remote === "index.json") parseIndex(bytes);
                this.#memory.set(key, bytes.slice());
                try {
                    await abortable(
                        Promise.resolve(this.#options.cache?.put(key, bytes.slice())),
                        signal
                    );
                } catch {
                    /* Read-only caches still permit verified in-memory use. */
                }
                return bytes;
            } catch {
                signal.throwIfAborted();
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
            }
        }
        throw new Error("Unable to load the pinned prover resource");
    }
}
