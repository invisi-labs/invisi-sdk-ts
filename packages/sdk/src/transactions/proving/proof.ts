import type { ProofBundle } from "@invisi-labs/prover";

/** Whitelist the public proof fields; a custom local backend cannot accidentally export its witness. */
export function publicProof(bundle: ProofBundle): ProofBundle {
    return {
        formatVersion: bundle.formatVersion,
        circuitName: bundle.circuitName,
        target: bundle.target,
        bbVersion: bundle.bbVersion,
        artifactSha256: bundle.artifactSha256,
        vkSha256: bundle.vkSha256,
        proofHex: bundle.proofHex,
        proofSha256: bundle.proofSha256,
        publicInputs: [...bundle.publicInputs],
    };
}
