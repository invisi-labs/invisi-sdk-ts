import { MissingCapabilityError } from "@invisi-labs/core";
import { assertExpectedProof } from "./backends/backend-service";
import type { CircuitName, ProofBundle } from "./circuits/circuit-types";
import {
    LocalWitness,
    type AggregateMember,
    type AggregatorCapability,
    type ProofStatement,
    type Prover,
    type ProverOptions,
} from "./interfaces";
import {
    aggregateCircuitPublicInputs,
    assertProofBundle,
    getCircuitKey,
    getCircuitMetadata,
} from "./proofs/proof-data";
function copy(bundle: ProofBundle): ProofBundle {
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
/** Explicit aggregation service. Runtime and backend selection belong to the caller. */
export class Aggregator implements AggregatorCapability {
    readonly #prover: Prover;
    constructor(options: { prover: Prover }) {
        if (!options.prover) throw new MissingCapabilityError("aggregation prover");
        this.#prover = options.prover;
        Object.freeze(this);
    }
    async aggregate(
        members: readonly AggregateMember[],
        options: ProverOptions = {}
    ): Promise<ProofBundle> {
        const frozen = members.map((member) => ({
            bundle: copy(member.bundle),
            statement: {
                ...member.statement,
                expectedPublicInputs: [...member.statement.expectedPublicInputs],
            },
        }));
        if (![4, 8, 12].includes(frozen.length))
            throw new Error("aggregation requires 4, 8 or 12 members");
        options.signal?.throwIfAborted();
        for (const member of frozen) {
            if (
                member.bundle.circuitName !== "transact_user_slots14" ||
                member.bundle.target !== "noir-recursive"
            )
                throw new Error("aggregation requires recursive slots14 members");
            await assertProofBundle(member.bundle);
            assertExpectedProof(member.bundle, member.statement);
        }
        const words = await aggregateCircuitPublicInputs(frozen.map((member) => member.bundle));
        for (const member of frozen) {
            options.signal?.throwIfAborted();
            let valid: boolean;
            try {
                valid = await this.#prover.verify(
                    copy(member.bundle),
                    structuredClone(member.statement),
                    options
                );
            } catch {
                options.signal?.throwIfAborted();
                throw new Error("aggregate member proof verification failed");
            }
            if (!valid) throw new Error("aggregate member proof verification failed");
        }
        const circuitName = `transact_aggregate_14_${frozen.length}` as CircuitName,
            metadata = getCircuitMetadata(circuitName),
            key = getCircuitKey(circuitName, "evm"),
            inner = getCircuitKey("transact_user_slots14", "noir-recursive");
        if (!inner.vkFields || !inner.vkHash)
            throw new Error("authenticated recursive verification key is missing");
        const expected: ProofStatement = {
                circuitName,
                target: "evm",
                artifactSha256: metadata.artifactSha256,
                vkSha256: key.vkSha256,
                expectedPublicInputs: words,
            },
            witness = new LocalWitness({
                verification_key: [...inner.vkFields],
                key_hash: inner.vkHash,
                proofs: frozen.map((member) =>
                    Array.from(
                        { length: 458 },
                        (_, i) => `0x${member.bundle.proofHex.slice(2 + 64 * i, 66 + 64 * i)}`
                    )
                ),
                statements: frozen.map((member) => [...member.bundle.publicInputs]),
                inner_vk_commitment: words.at(-1)!,
            });
        try {
            const bundle = copy(
                await this.#prover.prove({ ...structuredClone(expected), witness }, options)
            );
            await assertProofBundle(bundle);
            assertExpectedProof(bundle, expected);
            if (!(await this.#prover.verify(copy(bundle), structuredClone(expected), options)))
                throw new Error("invalid aggregate proof");
            options.signal?.throwIfAborted();
            return copy(bundle);
        } catch {
            options.signal?.throwIfAborted();
            throw new Error("aggregate proof generation or verification failed");
        }
    }
    toJSON() {
        return { capability: "aggregation" };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
export type { AggregateMember, AggregatorCapability } from "./interfaces";
