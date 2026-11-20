import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    ResourceLoader,
    resourceObject,
    resourcePath,
    type ResourceCache,
    type ResourceOptions,
} from "./loader";
import { coreResourcePin, provenanceResourcePin } from "./pin";
export interface NodeResourceOptions extends ResourceOptions {
    directory?: string;
    provenanceDirectory?: string;
    cacheDir?: string;
}
export function resourceCacheDir(options: NodeResourceOptions = {}): string {
    const base =
        process.platform === "darwin"
            ? join(homedir(), "Library", "Caches")
            : process.platform === "win32"
              ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
              : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return (
        options.cacheDir ||
        process.env.INVISI_PROVER_CACHE_DIR ||
        join(base, "invisi", "prover-assets")
    );
}
function directory(options: NodeResourceOptions): string | undefined {
    return options.directory ?? process.env.INVISI_PROVER_RESOURCE_DIR;
}
function fileName(key: string): string {
    return key.endsWith(".index.json") ? "index.json" : key;
}
class DiskCache implements ResourceCache {
    constructor(private readonly options: NodeResourceOptions) {}
    async get(
        key: string,
        options?: { maxBytes: number; signal: AbortSignal }
    ): Promise<Uint8Array | undefined> {
        for (const path of [
            directory(this.options) && join(directory(this.options)!, key),
            directory(this.options) && join(directory(this.options)!, fileName(key)),
            join(resourceCacheDir(this.options), key),
        ].filter(Boolean) as string[]) {
            try {
                const max =
                    options?.maxBytes ?? (key.endsWith(".index.json") ? 2 : 64) * 1024 * 1024;
                if ((await stat(path)).size > max) continue;
                const stream = createReadStream(path, {
                    end: max,
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                const chunks: Buffer[] = [];
                let total = 0;
                for await (const chunk of stream) {
                    total += chunk.length;
                    if (total > max) throw new Error("Cached resource exceeds limit");
                    chunks.push(chunk);
                }
                const bytes = Buffer.concat(chunks, total);
                if (createHash("sha256").update(bytes).digest("hex") !== key.split(".")[0])
                    continue;
                return new Uint8Array(bytes);
            } catch {
                /* Missing files are cache misses. */
            }
        }
        return undefined;
    }
    async put(key: string, value: Uint8Array): Promise<void> {
        const root = resourceCacheDir(this.options);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const temp = join(root, `.${key}.${randomUUID()}.tmp`);
        try {
            await writeFile(temp, value, { flag: "wx", mode: 0o600 });
            await rename(temp, join(root, key));
        } finally {
            await rm(temp, { force: true });
        }
    }
}
export function nodeResourceOptions(options: NodeResourceOptions = {}): NodeResourceOptions {
    return {
        ...options,
        offline: options.offline ?? process.env.INVISI_PROVER_OFFLINE === "1",
        cache: options.cache ?? new DiskCache(options),
    };
}
const defaults: NodeResourceOptions = {};
const loaders = new WeakMap<NodeResourceOptions, Map<string, ResourceLoader>>();
export function nodeResources(
    options: NodeResourceOptions = defaults,
    pin = coreResourcePin(options.release)
): ResourceLoader {
    let byPin = loaders.get(options);
    if (!byPin) loaders.set(options, (byPin = new Map()));
    let loader = byPin.get(pin);
    if (!loader) {
        loader = new ResourceLoader(
            {
                ...options,
                offline: options.offline ?? process.env.INVISI_PROVER_OFFLINE === "1",
                cache: options.cache ?? new DiskCache(options),
            },
            pin
        );
        byPin.set(pin, loader);
    }
    return loader;
}
/** Synchronous helpers only read already provisioned or cached resources. */
export function localResourcePath(
    logical: string,
    options: NodeResourceOptions = {},
    pin = coreResourcePin(options.release)
): string {
    resourcePath(logical);
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    let index: Uint8Array | undefined;
    for (const path of [
        directory(options) && join(directory(options)!, `${pin}.index.json`),
        directory(options) && join(directory(options)!, "index.json"),
        join(resourceCacheDir(options), `${pin}.index.json`),
    ].filter(Boolean) as string[]) {
        try {
            if (statSync(path).size > 2 * 1024 * 1024) continue;
            const bytes = readFileSync(path);
            if (digest(bytes) === pin) {
                index = bytes;
                break;
            }
        } catch {}
    }
    if (!index)
        throw new Error(
            "Pinned prover resources are not cached; prepare them asynchronously first"
        );
    const entry = JSON.parse(new TextDecoder().decode(index)).files[logical];
    if (
        !entry ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size <= 0 ||
        entry.size > 64 * 1024 * 1024
    )
        throw new Error("Resource is not in the pinned release");
    const name = resourceObject(logical, entry.sha256);
    for (const path of [
        directory(options) && join(directory(options)!, name),
        join(resourceCacheDir(options), name),
    ].filter(Boolean) as string[]) {
        try {
            if (statSync(path).size !== entry.size) continue;
            const bytes = readFileSync(path);
            if (bytes.length === entry.size && digest(bytes) === entry.sha256) return path;
        } catch {}
    }
    throw new Error("Pinned prover resource is unavailable in the local cache");
}

const provenanceOptions = new WeakMap<NodeResourceOptions, NodeResourceOptions>();
export function nodeProvenanceResources(options: NodeResourceOptions = defaults): ResourceLoader {
    let selected = provenanceOptions.get(options);
    if (!selected) {
        const { directory, baseUrls, ...rest } = options;
        const selectedDirectory = options.provenanceDirectory ?? directory;
        const selectedUrls =
            options.provenanceBaseUrls ?? (options.release === "legacy" ? baseUrls : undefined);
        selected = {
            ...rest,
            ...(selectedDirectory !== undefined ? { directory: selectedDirectory } : {}),
            ...(selectedUrls !== undefined ? { baseUrls: selectedUrls } : {}),
        };
        provenanceOptions.set(options, selected);
    }
    return nodeResources(selected, provenanceResourcePin(options.release));
}
