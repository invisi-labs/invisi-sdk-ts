import { selectAggregateRoute } from "@invisi-labs/core";
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
        const route = selectAggregateRoute(
            frozen.map((m) => getCircuitMetadata(m.bundle.circuitName).capacity!)
        );
        options.signal?.throwIfAborted();
        for (const member of frozen) {
            if (
                !member.bundle.circuitName.startsWith("transact_user_slots") ||
                member.bundle.target !== "noir-recursive"
            )
                throw new Error("aggregation requires recursive Note members");
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
        const circuitName = route.name as CircuitName,
            metadata = getCircuitMetadata(circuitName),
            key = getCircuitKey(circuitName, "evm");
        const inner = (capacity: number) => {
            const key = getCircuitKey(
                `transact_user_slots${capacity}` as CircuitName,
                "noir-recursive"
            );
            if (!key.vkFields || !key.vkHash)
                throw Error("authenticated recursive verification key is missing");
            return key;
        };
        const expected: ProofStatement = {
            circuitName,
            target: "evm",
            artifactSha256: metadata.artifactSha256,
            vkSha256: key.vkSha256,
            expectedPublicInputs: words,
        };
        const proofs = frozen.map((m) =>
            Array.from(
                { length: 458 },
                (_, i) => `0x${m.bundle.proofHex.slice(2 + 64 * i, 66 + 64 * i)}`
            )
        );
        const witness = new LocalWitness(
            route.kind === "dedicated"
                ? {
                      verification_key: [...inner(route.capacity).vkFields!],
                      key_hash: inner(route.capacity).vkHash!,
                      proofs,
                      statements: frozen.map((m) => [...m.bundle.publicInputs]),
                      inner_vk_commitment: words.at(-1)!,
                  }
                : {
                      verification_keys: [1, 2, 3, 4, 5].map((c) => [...inner(c).vkFields!]),
                      key_hashes: [1, 2, 3, 4, 5].map((c) => inner(c).vkHash!),
                      proofs,
                      capacities: frozen.map((m) =>
                          BigInt(getCircuitMetadata(m.bundle.circuitName).capacity!)
                      ),
                      statements: frozen.map((m) => [
                          ...m.bundle.publicInputs,
                          ...Array(32 - m.bundle.publicInputs.length).fill(0n),
                      ]),
                      inner_vk_commitments: metadata.innerVkCommitments!,
                  }
        );
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
