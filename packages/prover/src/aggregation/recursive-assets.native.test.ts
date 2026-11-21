import { describe, expect, it } from "vitest";
import { Aggregator } from "../aggregate";
import { NativeProver, checkBBAvailable } from "../native";
import type { AggregateMember } from "../interfaces";
import { assertProofBundle, getCircuitMetadata, makeProofBundle } from "../proofs/proof-data";
import { generateProofBundle, verifyProofBundle } from "../proofs/prover";
import { USER_FIXTURE } from "../testing/test-fixtures";

const bbBin = process.env.BB_BINARY_PATH;
const native = bbBin ? describe : describe.skip;

native("authenticated recursive assets with real BB6 (set BB_BINARY_PATH)", () => {
    it("aggregates a real recursive member using offline assets and rejects a cryptographically changed member", async () => {
        expect(await checkBBAvailable(bbBin)).toBe(true);
        const options = {
            bbBin: bbBin!,
            resources: { offline: true },
            threads: 4,
        };
        const bundle = await generateProofBundle({
            ...options,
            circuitName: "transact_user_slots2",
            target: "noir-recursive",
            inputs: USER_FIXTURE.witness,
            expectedPublicInputs: USER_FIXTURE.publicInputs,
        });
        expect(bundle.publicInputs).toEqual(USER_FIXTURE.publicInputs);
        expect(bundle.proofHex).toHaveLength(2 + 458 * 64);
        expect(await verifyProofBundle(bundle, options)).toBe(true);
        const member: AggregateMember = {
            bundle,
            statement: {
                circuitName: bundle.circuitName,
                target: bundle.target,
                artifactSha256: bundle.artifactSha256,
                vkSha256: bundle.vkSha256,
                expectedPublicInputs: [...bundle.publicInputs],
            },
        };
        const aggregator = new Aggregator({ prover: new NativeProver(options) });
        const outer = await aggregator.aggregate([member]);
        const commitment = getCircuitMetadata("transact_aggregate_2_1").innerVkCommitment;
        expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
        expect(outer.circuitName).toBe("transact_aggregate_2_1");
        expect(outer.target).toBe("evm");
        expect(outer.publicInputs).toEqual([...USER_FIXTURE.publicInputs, commitment]);
        expect(await verifyProofBundle(outer, options)).toBe(true);

        // Change a proof field while retaining a canonical field value, proof length,
        // release identity, and the public statement. Recompute the bundle digest so
        // only the native cryptographic verifier can reject this member.
        const wordOffset = bundle.proofHex.length - 64;
        const lastWord = BigInt(`0x${bundle.proofHex.slice(wordOffset)}`) ^ 1n;
        const changed = await makeProofBundle(
            bundle.circuitName,
            bundle.target,
            `0x${bundle.proofHex.slice(2, wordOffset)}${lastWord.toString(16).padStart(64, "0")}`,
            [...bundle.publicInputs]
        );
        await expect(assertProofBundle(changed)).resolves.toBeUndefined();
        expect(changed.proofSha256).not.toBe(bundle.proofSha256);
        await expect(verifyProofBundle(changed, options)).rejects.toThrow();
        await expect(aggregator.aggregate([{ ...member, bundle: changed }])).rejects.toThrow(
            "aggregate member proof verification failed"
        );
    }, 600_000);
});
