import { existsSync } from "node:fs";
import { FIRST_DRAW_ASSET_INDEX_SHA256 } from "../resources/pin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceCacheDir } from "../resources/node";
import type { ResourceOptions } from "../resources/loader";
/** Tests exercise the browser loader against the same externally provisioned release as Node. */
export const testResourceOptions: ResourceOptions = {
    offline: true,
    cache: {
        async get(key) {
            const directory = process.env.INVISI_PROVER_RESOURCE_DIR;
            for (const file of [
                directory && join(directory, key),
                join(resourceCacheDir(), key),
            ].filter(Boolean) as string[]) {
                try {
                    return new Uint8Array(await readFile(file));
                } catch {}
            }
            return undefined;
        },
        async put() {},
    },
};

/** Proof CI can run before the new Core resource set is published. */
export const hasFirstDrawTestResources = [
    process.env.INVISI_PROVER_RESOURCE_DIR,
    resourceCacheDir(),
].some(
    (directory) =>
        directory && existsSync(join(directory, `${FIRST_DRAW_ASSET_INDEX_SHA256}.index.json`))
);
