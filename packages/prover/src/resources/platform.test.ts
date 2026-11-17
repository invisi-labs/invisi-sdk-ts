import { afterEach, expect, it, vi } from "vitest";
import { BrowserCache } from "./browser";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeResources, resourceCacheDir } from "./node";
import { PROVER_ASSET_INDEX_SHA256 } from "./pin";
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
it("rejects oversized persistent browser cache streams before allocating the complete body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("caches", {
        open: async () => ({
            match: async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(9));
                        },
                        cancel,
                    })
                ),
        }),
    });
    await expect(
        new BrowserCache().get("test.json", { maxBytes: 8, signal: new AbortController().signal })
    ).rejects.toThrow("limit");
    expect(cancel).toHaveBeenCalledTimes(1);
});
it("cancels stalled browser cache reads", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("caches", {
        open: async () => ({
            match: async () => new Response(new ReadableStream({ start() {}, cancel })),
        }),
    });
    const controller = new AbortController();
    const pending = new BrowserCache().get("test.json", { maxBytes: 8, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await pending.catch(() => undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
});
it.skipIf(!process.env.INVISI_PROVER_RESOURCE_DIR)(
    "uses the actual Core release with persistent cold-download and offline replay",
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "invisi-resource-test-"));
        const source = process.env.INVISI_PROVER_RESOURCE_DIR!;
        vi.stubEnv("INVISI_PROVER_RESOURCE_DIR", "");
        vi.stubEnv("INVISI_PROVER_OFFLINE", "0");
        const fetcher = vi.fn(
            async (input: RequestInfo | URL) =>
                new Response(
                    await readFile(join(source, new URL(String(input)).pathname.split("/").at(-1)!))
                )
        );
        try {
            const loader = nodeResources({ cacheDir: directory, fetch: fetcher });
            const [a, b] = await Promise.all([
                loader.load("circuits/transact_user_slots1.json"),
                loader.load("circuits/transact_user_slots1.json"),
            ]);
            expect(a).toEqual(b);
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(
                await nodeResources({ cacheDir: directory, offline: true }).load(
                    "circuits/transact_user_slots1.json"
                )
            ).toEqual(a);
            const index = JSON.parse(
                await readFile(join(directory, `${PROVER_ASSET_INDEX_SHA256}.index.json`), "utf8")
            );
            const entry = index.files["circuits/transact_user_slots1.json"];
            await writeFile(join(directory, `${entry.sha256}.json`), "corrupt");
            await expect(
                nodeResources({ cacheDir: directory, offline: true }).load(
                    "circuits/transact_user_slots1.json"
                )
            ).rejects.toThrow();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);

it("uses the shared platform cache directory and explicit override precedence", () => {
    vi.stubEnv("INVISI_PROVER_CACHE_DIR", "");
    const root =
        process.platform === "darwin"
            ? join(homedir(), "Library", "Caches")
            : process.platform === "win32"
              ? process.env.LOCALAPPDATA!
              : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    expect(resourceCacheDir()).toBe(join(root, "invisi", "prover-assets"));
    vi.stubEnv("INVISI_PROVER_CACHE_DIR", "/configured/cache");
    expect(resourceCacheDir()).toBe("/configured/cache");
    expect(resourceCacheDir({ cacheDir: "/explicit/cache" })).toBe("/explicit/cache");
});
