import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
    coreResourcePin,
    provenanceResourcePin,
    circuitResourcePin,
    PROVER_ASSET_INDEX_SHA256,
    PROVENANCE_ASSET_INDEX_SHA256,
    LEGACY_PROVER_ASSET_INDEX_SHA256,
} from "./pin";
import { nodeResources, nodeProvenanceResources } from "./node";
import { browserProvenanceResources } from "./browser";
const fixtures = resolve(import.meta.dirname, "../../../../test-support/prover-resources");
it("routes every Core circuit and Provenance to distinct immutable pins with explicit legacy", () => {
    expect(PROVER_ASSET_INDEX_SHA256).toBe(
        "36f58bac1a0f70c6f8422b47f7cc35a30416a20f8a0f30038d23db0832e2bc93"
    );
    expect(PROVENANCE_ASSET_INDEX_SHA256).toBe(
        "8d5a3e60e3e5cbe315150511207d7aff67f4e2924148d396b67d82017ecd1f1c"
    );
    expect(circuitResourcePin("create_credit_initial_payment")).toBe(coreResourcePin());
    expect(provenanceResourcePin("legacy")).toBe(LEGACY_PROVER_ASSET_INDEX_SHA256);
    expect(coreResourcePin("legacy")).toBe(LEGACY_PROVER_ASSET_INDEX_SHA256);
});
it("loads isolated Core and Provenance directories offline using one shared cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "split-resources-"));
    try {
        const core = join(root, "core"),
            prov = join(root, "prov");
        mkdirSync(core);
        mkdirSync(prov);
        for (const [dir, name] of [
            [core, "core"],
            [prov, "provenance"],
        ])
            writeFileSync(
                join(dir!, "index.json"),
                readFileSync(join(fixtures, name + ".index.json"))
            );
        const ci = JSON.parse(readFileSync(join(fixtures, "core.index.json"), "utf8"));
        const key = ci.files["circuits/transact_user_slots2.evm.vk"].sha256 + ".vk";
        writeFileSync(join(core, key), readFileSync(join(fixtures, "core.vk")));
        const pi = JSON.parse(readFileSync(join(fixtures, "provenance.index.json"), "utf8"));
        writeFileSync(
            join(prov, pi.files["provenance/manifest.json"].sha256 + ".json"),
            readFileSync(resolve(import.meta.dirname, "provenance-manifest.json"))
        );
        const options = {
            directory: core,
            provenanceDirectory: prov,
            cacheDir: join(root, "cache"),
            offline: true,
        };
        expect(
            (await nodeResources(options).load("circuits/transact_user_slots2.evm.vk")).length
        ).toBe(1888);
        expect(
            JSON.parse(
                new TextDecoder().decode(
                    await nodeProvenanceResources(options).load("provenance/manifest.json")
                )
            ).family
        ).toBe("provenance");
        await expect(nodeResources(options).load("provenance/manifest.json")).rejects.toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
it("Provenance browser transport uses its own source and never downgrades after a failed index", async () => {
    const urls: string[] = [];
    const options = {
        baseUrls: ["https://core.invalid/"],
        provenanceBaseUrls: ["https://prov.invalid/"],
        fetch: async (input: RequestInfo | URL) => {
            urls.push(String(input));
            return new Response("missing", { status: 404 });
        },
    };
    await expect(
        browserProvenanceResources(options).load("provenance/manifest.json")
    ).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://prov.invalid/"))).toBe(true);
    expect(urls.some((u) => u.includes(LEGACY_PROVER_ASSET_INDEX_SHA256))).toBe(false);
});
it.skipIf(!process.env.INVISI_TEST_LEGACY_RESOURCES)(
    "authenticates historical combined catalogs only in explicit legacy mode",
    async () => {
        const options = {
            release: "legacy" as const,
            offline: true,
            directory: process.env.INVISI_TEST_LEGACY_RESOURCES!,
        };
        expect(
            (await nodeResources(options).load("circuits/transact_user_slots2.evm.vk")).length
        ).toBeGreaterThan(0);
        expect(
            (await nodeProvenanceResources(options).load("provenance/manifest.json")).length
        ).toBeGreaterThan(0);
        expect(
            (
                await nodeResources(
                    options,
                    circuitResourcePin("create_credit_initial_payment", "legacy")
                ).load("circuits/create_credit_initial_payment.evm.vk")
            ).length
        ).toBeGreaterThan(0);
    }
);
