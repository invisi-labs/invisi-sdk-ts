import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeProver } from "./native";
import {
    ProvenanceClient,
    PROVENANCE_MANIFEST_SHA256,
    PUBLIC_INPUTS,
    word,
    type Witness,
} from "@invisi-labs/core/provenance";
const scope = { chainId: "31337", protocolAddress: "0x0000000000000000000000000000000000001234" };
function client(context = scope) {
    return new ProvenanceClient("https://private.example", {
        ...context,
        chainGeneration: "1",
        providerId: word(1),
        signingKeys: {},
        manifestSha256: PROVENANCE_MANIFEST_SHA256,
    });
}
it("accepts a private client without contacting the official service or loading a proving runtime", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("unexpected network"));
    try {
        const source = client();
        const prover = new NativeProver({
            provenanceClient: source,
            bbBin: "not-needed-for-client",
        });
        expect(await prover.getProvenanceClient(scope)).toBe(source);
        await expect(prover.getProvenanceClient({ ...scope, chainId: "1" })).rejects.toThrow(
            /deployment/
        );
        const wrong = client();
        wrong.trust.manifestSha256 = "f".repeat(64);
        await expect(
            new NativeProver({ provenanceClient: wrong }).getProvenanceClient(scope)
        ).rejects.toThrow(/manifest/);
        expect(fetch).not.toHaveBeenCalled();
    } finally {
        fetch.mockRestore();
    }
});
const root = process.env.INVISI_PROTOCOL_ROOT;
it.skipIf(!root || !process.env.INVISI_TEST_NATIVE_SOURCE)(
    "uses the same native BB configuration for genuine K1 source proving and independent verification",
    async () => {
        const vectors = JSON.parse(
            await readFile(join(root!, "circuits/provenance/golden-vectors.json"), "utf8")
        );
        const witness = vectors.witnessK1 as Witness;
        const context = {
            chainId: String(witness.chain_id),
            protocolAddress: String(witness.protocol_address),
        };
        const prover = new NativeProver({
            bbBin: process.env.BB_BINARY_PATH ?? "bb",
            threads: 4,
            provenanceClient: client(context),
            ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
        });
        const capability = await prover.getProvenanceCapability(context);
        const expected = PUBLIC_INPUTS.map((k) => word(witness[k] as bigint));
        const result = await capability.prover.prove({
            identity: capability.manifest,
            capacity: 1,
            witness,
            expectedPublicInputs: expected,
        });
        expect(result.publicInputs).toEqual(expected);
        expect(result.proof.length).toBeGreaterThan(1000);
    },
    180000
);
