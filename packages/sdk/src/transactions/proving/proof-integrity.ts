import type { ProofBundle, ProofStatement } from "@invisi-labs/prover";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { getBytes } from "ethers/utils";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
export function sameStatement(proof: ProofBundle, expected: ProofStatement): void {
    check(
        proof.formatVersion === 1 &&
            proof.bbVersion === "6.0.0" &&
            proof.circuitName === expected.circuitName &&
            proof.target === expected.target &&
            proof.artifactSha256 === expected.artifactSha256 &&
            proof.vkSha256 === expected.vkSha256,
        "proof release/target mismatch"
    );
    check(
        proof.publicInputs.length === expected.expectedPublicInputs.length &&
            proof.publicInputs.every((word, i) => word === expected.expectedPublicInputs[i]),
        "proof public statement mismatch"
    );
    check(
        /^0x(?:[a-fA-F0-9]{2})+$/.test(proof.proofHex) &&
            bytesToHex(sha256(getBytes(proof.proofHex))) === proof.proofSha256,
        "proof integrity mismatch"
    );
}
