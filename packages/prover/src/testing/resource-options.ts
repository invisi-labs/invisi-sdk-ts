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

/** Real proof suites include initial-payment from the same Core catalog. */
export function initialPaymentProofsEnabled(env: Record<string, string | undefined>) {
    if (env.INVISI_SKIP_INITIAL_PAYMENT_PROOFS === "1") {
        if (env.CI)
            throw Error(
                "CI must run initial-payment proofs with the independently pinned resources"
            );
        return false;
    }
    return true;
}
export const runInitialPaymentProofs = initialPaymentProofsEnabled(process.env);
