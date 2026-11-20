import { coreResourcePin, provenanceResourcePin } from "./pin";
import { ResourceLoader, type ResourceCache, type ResourceOptions } from "./loader";
export class BrowserCache implements ResourceCache {
    async get(
        key: string,
        options?: { maxBytes: number; signal: AbortSignal }
    ): Promise<Uint8Array | undefined> {
        if (typeof caches === "undefined") return undefined;
        const cache = await caches.open("invisi-prover-assets-v1");
        const response = await cache.match(`https://invisi-resource-cache.invalid/${key}`);
        if (!response) return undefined;
        const max = options?.maxBytes ?? (key.endsWith(".index.json") ? 2 : 64) * 1024 * 1024;
        const length = response.headers.get("Content-Length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
            throw new Error("Cached resource exceeds limit");
        const reader = response.body?.getReader();
        if (!reader) return undefined;
        const cancel = () => {
            void reader.cancel().catch(() => {});
        };
        options?.signal.addEventListener("abort", cancel, { once: true });
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                options?.signal.throwIfAborted();
                const item = await reader.read();
                if (item.done) break;
                total += item.value.length;
                if (total > max) throw new Error("Cached resource exceeds limit");
                chunks.push(item.value);
            }
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            return bytes;
        } finally {
            options?.signal.removeEventListener("abort", cancel);
            cancel();
        }
    }
    async put(key: string, value: Uint8Array): Promise<void> {
        if (typeof caches === "undefined") return;
        const cache = await caches.open("invisi-prover-assets-v1");
        await cache.put(
            `https://invisi-resource-cache.invalid/${key}`,
            new Response(new Uint8Array(value))
        );
    }
}
const defaults: ResourceOptions = {};
const loaders = new WeakMap<ResourceOptions, Map<string, ResourceLoader>>();
export function browserResources(
    options: ResourceOptions = defaults,
    pin = coreResourcePin(options.release)
): ResourceLoader {
    let byPin = loaders.get(options);
    if (!byPin) loaders.set(options, (byPin = new Map()));
    let loader = byPin.get(pin);
    if (!loader) {
        loader = new ResourceLoader(
            { ...options, cache: options.cache ?? new BrowserCache() },
            pin
        );
        byPin.set(pin, loader);
    }
    return loader;
}

const provenanceOptions = new WeakMap<ResourceOptions, ResourceOptions>();
export function browserProvenanceResources(options: ResourceOptions = defaults): ResourceLoader {
    let selected = provenanceOptions.get(options);
    if (!selected) {
        const { baseUrls, ...rest } = options;
        const selectedUrls =
            options.provenanceBaseUrls ?? (options.release === "legacy" ? baseUrls : undefined);
        selected = { ...rest, ...(selectedUrls !== undefined ? { baseUrls: selectedUrls } : {}) };
        provenanceOptions.set(options, selected);
    }
    return browserResources(selected, provenanceResourcePin(options.release));
}
