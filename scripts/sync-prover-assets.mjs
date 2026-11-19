/** Explicit provisioning of reviewed public prover resources; never an install hook. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function reviewedPin(set = "default") {
    const text = readFileSync(join(repository, "packages/prover/src/resources/pin.ts"), "utf8");
    assert(set === "default" || set === "initial-payment", "Unknown prover resource set");
    const pattern =
        set === "default"
            ? /PROVER_ASSET_INDEX_SHA256\s*=\s*["']([a-f0-9]{64})["']/
            : /INITIAL_PAYMENT_ASSET_INDEX_SHA256\s*=\s*["']([a-f0-9]{64})["']/;
    const pin = text.match(pattern)?.[1];
    assert(pin, "Missing reviewed prover resource pin");
    return pin;
}
export function parseIndex(bytes, pin) {
    assert(bytes.length <= 2 * 1024 * 1024, "Resource index exceeds limit");
    assert.equal(hash(bytes), pin, "Untrusted resource index; review the source pin explicitly");
    const index = JSON.parse(bytes);
    assert.equal(index.format, "invisi.prover-assets.v1");
    assert.equal(index.noirVersion, "1.0.0");
    assert.equal(index.bbVersion, "6.0.0");
    assert(
        index.files && typeof index.files === "object" && !Array.isArray(index.files),
        "Invalid resource inventory"
    );
    for (const [path, entry] of Object.entries(index.files)) {
        assert(
            /^(circuits|provenance)\/[A-Za-z0-9_./-]+$/.test(path) &&
                !path.split("/").some((p) => !p || p === "." || p === ".."),
            "Unsafe resource path"
        );
        assert(
            path.endsWith(".json") || path.endsWith(".vk") || path.endsWith("/vk"),
            "Unknown resource type"
        );
        assert(entry && /^[a-f0-9]{64}$/.test(entry.sha256), "Invalid resource hash");
        assert(
            Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 64 * 1024 * 1024,
            "Invalid resource size"
        );
    }
    return index;
}
export const objectName = (path, entry) =>
    `${entry.sha256}.${path.endsWith(".json") ? "json" : "vk"}`;
async function atomicWrite(path, bytes) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}
async function localBytes(path, limit) {
    assert((await stat(path)).size <= limit, "Resource file exceeds limit");
    const bytes = await readFile(path);
    assert(bytes.length <= limit, "Resource file exceeds limit");
    return bytes;
}
async function download(url, limit, fetcher) {
    const address = new URL(url);
    assert(
        address.protocol === "https:" && !address.username && !address.password,
        "Only HTTPS resource URLs are supported"
    );
    const response = await fetcher(address, {
        signal: AbortSignal.timeout(60_000),
        credentials: "omit",
        referrerPolicy: "no-referrer",
    });
    assert(response.ok, `Resource download failed (${response.status})`);
    assert(
        !response.url || new URL(response.url).protocol === "https:",
        "Unsafe resource redirect"
    );
    const length = response.headers.get("content-length");
    assert(
        length === null || (/^\d+$/.test(length) && Number(length) <= limit),
        "Resource response exceeds limit"
    );
    const reader = response.body?.getReader();
    assert(reader, "Empty resource response");
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            total += item.value.length;
            assert(total <= limit, "Resource response exceeds limit");
            chunks.push(item.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, total);
}
export async function provision({
    source,
    output,
    paths = [],
    pin = reviewedPin(),
    fetcher = fetch,
} = {}) {
    const destination = resolve(
        output ??
            (process.env.INVISI_PROVER_CACHE_DIR || undefined) ??
            join(
                process.platform === "darwin"
                    ? join(homedir(), "Library", "Caches")
                    : process.platform === "win32"
                      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
                      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
                "invisi",
                "prover-assets"
            )
    );
    const bases = [
        `https://assets.invisipay.fi/prover/sets/${pin}/`,
        `https://github.com/invisi-labs/invisi-core/releases/download/prover-assets-${pin}/`,
    ];
    const obtain = async (name, limit) => {
        if (source) return localBytes(join(resolve(source), name), limit);
        let lastError;
        for (const base of bases) {
            try {
                return await download(new URL(name, base), limit, fetcher);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    };
    let indexBytes;
    try {
        indexBytes = await localBytes(join(destination, `${pin}.index.json`), 2 * 1024 * 1024);
        parseIndex(indexBytes, pin);
    } catch {
        indexBytes = await obtain("index.json", 2 * 1024 * 1024);
    }
    const index = parseIndex(indexBytes, pin);
    const selected = paths.length ? paths : Object.keys(index.files);
    const objects = new Set();
    for (const path of selected) {
        const entry = index.files[path];
        assert(entry, `Resource is not in the reviewed release: ${path}`);
        const name = objectName(path, entry);
        if (objects.has(name)) continue;
        let bytes;
        try {
            const cached = await localBytes(join(destination, name), entry.size);
            if (cached.length === entry.size && hash(cached) === entry.sha256) bytes = cached;
        } catch {
            /* Repair incomplete or missing cache objects. */
        }
        if (!bytes) bytes = await obtain(name, entry.size);
        assert.equal(bytes.length, entry.size, `Resource size mismatch: ${path}`);
        assert.equal(hash(bytes), entry.sha256, `Resource integrity mismatch: ${path}`);
        await atomicWrite(join(destination, name), bytes);
        objects.add(name);
    }
    // Publish the index only after every selected object has passed integrity checks.
    await atomicWrite(join(destination, `${pin}.index.json`), indexBytes);
    await atomicWrite(join(destination, "index.json"), indexBytes);
    return { destination, indexSha256: pin, objects: objects.size, index };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2),
        options = { paths: [] };
    while (args.length) {
        const flag = args.shift();
        assert(
            ["--source", "--output", "--path", "--set"].includes(flag) && args.length,
            "Usage: sync-prover-assets.mjs [--source CORE_RESOURCE_DIRECTORY] [--output CACHE_DIRECTORY] [--path LOGICAL_PATH ...] [--set default|initial-payment]"
        );
        const value = args.shift();
        if (flag === "--path") options.paths.push(value);
        else if (flag === "--set") options.pin = reviewedPin(value);
        else options[flag.slice(2)] = value;
    }
    const { destination, indexSha256, objects } = await provision(options);
    console.log(JSON.stringify({ destination, indexSha256, objects }));
}
