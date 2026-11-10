import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authenticateManifest, PUBLIC_INPUTS, word } from "@invisi-labs/core/provenance";
import type { Witness } from "@invisi-labs/core/provenance";
import { LocalProvenanceProver } from "./provenance";
const root = process.env.INVISI_PROTOCOL_ROOT;
it.skipIf(!root).each(["witnessK10SingleInput", "witnessK10CrossTree"])(
    "proves genuine independent provenance witness with local WASM and pinned assets",
    async (witnessKey) => {
        const capacity = 10;
        const manifest = await readFile(join(root!, "circuits/provenance/manifest.json"));
        const pin = "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762";
        const identity = authenticateManifest(manifest, pin);
        const data = JSON.parse(
            await readFile(join(root!, "circuits/provenance/golden-vectors.json"), "utf8")
        );
        const witness = data[witnessKey] as Witness;
        const expected = PUBLIC_INPUTS.map((k) => word(witness[k] as bigint));
        const prover = new LocalProvenanceProver({
            trustedManifestSha256: pin,
            threads: 4,
            ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
            loadAssets: async (capacity) => {
                const e = identity.manifest.circuits.find(
                    (e) => e.capacity === capacity
                )! as (typeof identity.manifest.circuits)[number] & {
                    artifact: string;
                    vk: string;
                };
                return {
                    manifest,
                    artifact: await readFile(join(root!, e.artifact)),
                    verificationKey: await readFile(join(root!, e.vk)),
                };
            },
        });
        const result = await prover.prove({
            identity,
            capacity,
            witness,
            expectedPublicInputs: expected,
        });
        expect(result.publicInputs).toEqual(expected);
        expect(result.proof.length).toBeGreaterThan(1000);
    },
    120000
);
