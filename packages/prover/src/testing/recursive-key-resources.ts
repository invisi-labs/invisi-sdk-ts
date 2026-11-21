import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getCircuitKey } from "../proofs/proof-data";
import { PROVER_ASSET_INDEX_SHA256 } from "../resources/pin";
import type { ResourceOptions } from "../resources/loader";
import type { CircuitName } from "../circuits/circuit-types";
const root = resolve(import.meta.dirname, "../../../../test-support/prover-resources");
/** Exact published public VK bytes, provisioned as offline resource-cache fixtures. */
export const recursiveKeyResources: ResourceOptions = {
    offline: true,
    cache: {
        async get(key) {
            if (key === `${PROVER_ASSET_INDEX_SHA256}.index.json`)
                return new Uint8Array(await readFile(join(root, "core.index.json")));
            for (let capacity = 1; capacity <= 10; capacity++) {
                const name = `transact_user_slots${capacity}` as CircuitName;
                if (key === `${getCircuitKey(name, "noir-recursive").vkSha256}.vk`)
                    return new Uint8Array(await readFile(join(root, "recursive", `${name}.vk`)));
            }
            return undefined;
        },
        async put() {},
    },
};
