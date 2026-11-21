import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeProver } from "./native";
import { WasmProver } from "./wasm";
import { getCircuitKey } from "./proofs/proof-data";
import type { NodeResourceOptions } from "./resources/node";
import { LEGACY_PROVER_ASSET_INDEX_SHA256, PROVER_ASSET_INDEX_SHA256 } from "./resources/pin";

vi.mock("@aztec-foundation/bb.js", () => {
    throw Error("Verification key loading must not import the proving runtime");
});
vi.mock("@noir-lang/noir_js", () => {
    throw Error("Verification key loading must not import the witness runtime");
});

const fixtures = resolve(import.meta.dirname, "../../../test-support/prover-resources");
const name = "transact_user_slots2";
async function fixture() {
    const index = new Uint8Array(await readFile(join(fixtures, "core.index.json")));
    const key = new Uint8Array(await readFile(join(fixtures, "core.vk")));
    const objects = new Map([
        [`${PROVER_ASSET_INDEX_SHA256}.index.json`, index],
        [`${getCircuitKey(name, "evm").vkSha256}.vk`, key],
    ]);
    const cache = {
        get: vi.fn(async (key: string) => objects.get(key)),
        put: vi.fn(async () => {}),
    };
    const fetcher = vi.fn(async () => {
        throw Error("Unexpected network access");
    });
    return { index, key, objects, cache, fetcher };
}

for (const [backend, create] of [
    [
        "native",
        (resources: NodeResourceOptions) => new NativeProver({ resources, bbBin: "unused" }),
    ],
    ["wasm", (resources: NodeResourceOptions) => new WasmProver({ resources })],
] as const) {
    it(`${backend} lazily loads authenticated key bytes using its configured offline cache`, async () => {
        const f = await fixture();
        const prover = create({ cache: f.cache, fetch: f.fetcher, offline: true });
        expect(f.cache.get).not.toHaveBeenCalled();
        expect(f.fetcher).not.toHaveBeenCalled();
        expect(await prover.loadVerificationKey(name, "evm")).toEqual(f.key);
        expect(f.cache.get.mock.calls.map(([key]) => key)).toEqual([
            `${PROVER_ASSET_INDEX_SHA256}.index.json`,
            `${getCircuitKey(name, "evm").vkSha256}.vk`,
        ]);
        expect(f.fetcher).not.toHaveBeenCalled();
    });

    it(`${backend} selects the recursive key independently from the EVM key`, async () => {
        const f = await fixture();
        const prover = create({ cache: f.cache, fetch: f.fetcher, offline: true });
        await expect(prover.loadVerificationKey(name, "noir-recursive")).rejects.toThrow(/offline/);
        expect(f.cache.get.mock.calls.map(([key]) => key)).toEqual([
            `${PROVER_ASSET_INDEX_SHA256}.index.json`,
            `${getCircuitKey(name, "noir-recursive").vkSha256}.vk`,
        ]);
        expect(f.fetcher).not.toHaveBeenCalled();
    });

    it(`${backend} rejects corrupt cached keys and preserves per-call cancellation`, async () => {
        const f = await fixture();
        f.objects.set(`${getCircuitKey(name, "evm").vkSha256}.vk`, new Uint8Array(f.key.length));
        const prover = create({ cache: f.cache, fetch: f.fetcher, offline: true });
        await expect(prover.loadVerificationKey(name, "evm")).rejects.toThrow();
        f.cache.get.mockClear();
        const controller = new AbortController();
        const reason = Error("Cancelled key request");
        controller.abort(reason);
        await expect(
            prover.loadVerificationKey(name, "evm", { signal: controller.signal })
        ).rejects.toBe(reason);
        expect(f.cache.get).not.toHaveBeenCalled();
        expect(f.fetcher).not.toHaveBeenCalled();
    });

    it(`${backend} keeps an explicit release pin instead of falling back to the default catalog`, async () => {
        const f = await fixture();
        const prover = create({
            cache: f.cache,
            fetch: f.fetcher,
            offline: true,
            release: "legacy",
        });
        await expect(prover.loadVerificationKey(name, "evm")).rejects.toThrow(/offline/);
        expect(f.cache.get.mock.calls.map(([key]) => key)).toEqual([
            `${LEGACY_PROVER_ASSET_INDEX_SHA256}.index.json`,
        ]);
        expect(f.fetcher).not.toHaveBeenCalled();
    });
}

it("native key loading honors a provisioned directory and an isolated offline cache directory", async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "invisi-backend-key-"));
    try {
        await writeFile(join(directory, "index.json"), f.index);
        await writeFile(join(directory, `${getCircuitKey(name, "evm").vkSha256}.vk`), f.key);
        const prover = new NativeProver({
            bbBin: "unused",
            resources: {
                directory,
                cacheDir: join(directory, "empty-cache"),
                offline: true,
                fetch: f.fetcher,
            },
        });
        expect(await prover.loadVerificationKey(name, "evm")).toEqual(f.key);
        expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
