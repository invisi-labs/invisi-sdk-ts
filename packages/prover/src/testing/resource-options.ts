import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceCacheDir } from "../resources/node";
import { PROVER_ASSET_INDEX_SHA256 } from "../resources/pin";
import type { ResourceOptions } from "../resources/loader";
/** Tests exercise the browser loader against the same externally provisioned release as Node. */
export const testResourceOptions: ResourceOptions = {
    offline: true,
    cache: {
        async get(key) {
            const directory = process.env.INVISI_PROVER_RESOURCE_DIR;
            const file = directory
                ? join(
                      directory,
                      key === `${PROVER_ASSET_INDEX_SHA256}.index.json` ? "index.json" : key
                  )
                : join(resourceCacheDir(), key);
            try {
                return new Uint8Array(await readFile(file));
            } catch {
                return undefined;
            }
        },
        async put() {},
    },
};
