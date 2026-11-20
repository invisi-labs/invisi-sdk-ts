import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeProver } from "./native";
import { PROVENANCE_MANIFEST_SHA256, PUBLIC_INPUTS, word } from "@invisi-labs/protocol/provenance";
import { type Witness } from "@invisi-labs/prover/provenance-witness";
it("loads authenticated local assets without network or a proving runtime", async () => {
    const transport = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("unexpected network"));
    try {
        const capability = await new NativeProver({
            bbBin: "not-needed-for-assets",
        }).getProvenanceCapability();
        expect(capability.manifest.sha256).toBe(PROVENANCE_MANIFEST_SHA256);
        expect(transport).not.toHaveBeenCalled();
    } finally {
        transport.mockRestore();
    }
});
const root = process.env.INVISI_PERIPHERY_ROOT;
it.skipIf(!root || !process.env.INVISI_TEST_NATIVE_SOURCE)(
    "uses the same native BB configuration for genuine K10 source proving and independent verification",
    async () => {
        const vectors = JSON.parse(
            await readFile(join(root!, "circuits/provenance/golden-vectors.json"), "utf8")
        );
        const witness = vectors.witnessK10SingleInput as Witness;
        const context = {
            chainId: String(witness.chain_id),
            protocolAddress: String(witness.protocol_address),
        };
        const prover = new NativeProver({
            bbBin: process.env.BB_BINARY_PATH ?? "bb",
            threads: 4,
            ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
        });
        const capability = await prover.getProvenanceCapability();
        const expected = PUBLIC_INPUTS.map((k) => word(witness[k] as bigint));
        const result = await capability.prover.prove({
            identity: capability.manifest,
            capacity: 10,
            witness,
            expectedPublicInputs: expected,
        });
        expect(result.publicInputs).toEqual(expected);
        expect(result.proof.length).toBeGreaterThan(1000);
    },
    180000
);
