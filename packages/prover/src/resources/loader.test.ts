import { expect, it, vi } from "vitest";
import { ResourceLoader, type ResourceCache } from "./loader";
const sha = async (bytes: Uint8Array) =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
async function fixture() {
    const artifact = new TextEncoder().encode('{"bytecode":"example"}');
    const hash = await sha(artifact);
    const index = new TextEncoder().encode(
        JSON.stringify({
            format: "invisi.prover-assets.v1",
            noirVersion: "1.0.0",
            bbVersion: "6.0.0",
            files: { "circuits/example.json": { sha256: hash, size: artifact.length } },
        })
    );
    const pin = await sha(index);
    const stored = new Map<string, Uint8Array>();
    const cache: ResourceCache = {
        get: async (key) => stored.get(key),
        put: async (key, value) => {
            stored.set(key, value.slice());
        },
    };
    const fetcher = vi.fn(
        async (input: RequestInfo | URL) =>
            new Response(String(input).endsWith("index.json") ? index : artifact)
    );
    return { artifact, index, pin, hash, stored, cache, fetcher };
}
it("loads only the requested asset, verifies it and shares concurrent downloads", async () => {
    const f = await fixture();
    const loader = new ResourceLoader({ cache: f.cache, fetch: f.fetcher }, f.pin);
    const [a, b] = await Promise.all([
        loader.load("circuits/example.json"),
        loader.load("circuits/example.json"),
    ]);
    expect(a).toEqual(f.artifact);
    expect(b).toEqual(f.artifact);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    a.fill(0);
    expect(await loader.load("circuits/example.json")).toEqual(f.artifact);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("uses a verified persistent cache offline and detects corrupted objects", async () => {
    const f = await fixture();
    await new ResourceLoader({ cache: f.cache, fetch: f.fetcher }, f.pin).load(
        "circuits/example.json"
    );
    expect(
        await new ResourceLoader({ cache: f.cache, offline: true }, f.pin).load(
            "circuits/example.json"
        )
    ).toEqual(f.artifact);
    f.stored.set(`${f.hash}.json`, new Uint8Array(f.artifact.length));
    await expect(
        new ResourceLoader({ cache: f.cache, offline: true }, f.pin).load("circuits/example.json")
    ).rejects.toThrow();
    expect(
        await new ResourceLoader({ cache: f.cache, fetch: f.fetcher }, f.pin).load(
            "circuits/example.json"
        )
    ).toEqual(f.artifact);
});
it("rejects a replaced index, truncated download and oversized response without caching", async () => {
    const f = await fixture();
    for (const mode of ["index", "truncated", "oversized"]) {
        const fetcher = vi.fn(
            async (input: RequestInfo | URL) =>
                new Response(
                    String(input).endsWith("index.json")
                        ? mode === "index"
                            ? "{}"
                            : f.index
                        : mode === "truncated"
                          ? f.artifact.slice(1)
                          : new Uint8Array(f.artifact.length + 1)
                )
        );
        const cache = { get: async () => undefined, put: vi.fn(async () => {}) };
        await expect(
            new ResourceLoader({ fetch: fetcher, cache }, f.pin).load("circuits/example.json")
        ).rejects.toThrow();
        if (mode === "index") expect(cache.put).not.toHaveBeenCalled();
        else expect(cache.put).toHaveBeenCalledTimes(1);
    }
});
it("tries a configured mirror but never follows resource URLs from index content", async () => {
    const f = await fixture();
    let first = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        if (first) {
            first = false;
            throw new Error("network");
        }
        return f.fetcher(input);
    });
    const loader = new ResourceLoader(
        {
            fetch: fetcher,
            baseUrls: ["https://primary.example/assets/", "https://mirror.example/assets/"],
        },
        f.pin
    );
    expect(await loader.load("circuits/example.json")).toEqual(f.artifact);
    await expect(loader.load("../private.key")).rejects.toThrow();
});
it("does not fetch at construction and cancellation does not cancel another subscriber", async () => {
    const f = await fixture();
    let unblock!: () => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        await new Promise<void>((r) => {
            unblock = r;
        });
        return f.fetcher(input);
    });
    const loader = new ResourceLoader({ fetch: fetcher }, f.pin);
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const a = loader.load("circuits/example.json", controller.signal);
    const b = loader.load("circuits/example.json");
    await vi.waitFor(() => expect(unblock).toBeTypeOf("function"));
    controller.abort();
    await expect(a).rejects.toThrow();
    unblock();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    unblock();
    expect(await b).toEqual(f.artifact);
});

it("bounds stalled transports and recovers from a cancelled single subscriber", async () => {
    const f = await fixture();
    const loader = new ResourceLoader(
        { fetch: async () => new Promise<Response>(() => {}), timeoutMs: 10 },
        f.pin
    );
    await expect(loader.load("circuits/example.json")).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    const active = new ResourceLoader({ fetch: f.fetcher }, f.pin);
    await expect(active.load("circuits/example.json", controller.signal)).rejects.toThrow();
    expect(await active.load("circuits/example.json")).toEqual(f.artifact);
});
it("bounds stalled body reads and caches", async () => {
    const f = await fixture();
    const loader = new ResourceLoader(
        { fetch: async () => new Response(new ReadableStream({ start() {} })), timeoutMs: 10 },
        f.pin
    );
    await expect(loader.load("circuits/example.json")).rejects.toThrow();
    const cache: ResourceCache = {
        get: async () => new Promise<Uint8Array | undefined>(() => {}),
        put: async () => {},
    };
    await expect(
        new ResourceLoader({ cache, timeoutMs: 10 }, f.pin).load("circuits/example.json")
    ).rejects.toThrow();
});
it("passes exact bounds to persistent cache reads", async () => {
    const f = await fixture();
    const limits: number[] = [];
    const cache: ResourceCache = {
        get: async (_key, options) => {
            limits.push(options!.maxBytes);
            return undefined;
        },
        put: async () => {},
    };
    await new ResourceLoader({ fetch: f.fetcher, cache }, f.pin).load("circuits/example.json");
    expect(limits).toEqual([2 * 1024 * 1024, f.artifact.length]);
});
