import type { CircuitName, ProofTarget, Hex, ProofBundle } from "./circuit-types";
function clone(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clone);
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    if (
        value === null ||
        ["string", "bigint", "number", "boolean", "undefined"].includes(typeof value)
    )
        return value;
    throw new TypeError("unsupported witness value");
}
/** Sensitive local circuit inputs. They never appear in public request serialization. */
export class LocalWitness {
    readonly #inputs: Record<string, unknown>;
    constructor(inputs: Record<string, unknown>) {
        this.#inputs = clone(inputs) as Record<string, unknown>;
        Object.freeze(this);
    }
    withInputs<T>(consumer: (inputs: Record<string, unknown>) => T): T {
        return consumer(clone(this.#inputs) as Record<string, unknown>);
    }
    toJSON() {
        return { localWitness: "[redacted]" };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
export interface ProofStatement {
    circuitName: CircuitName;
    target: ProofTarget;
    artifactSha256: string;
    vkSha256: string;
    expectedPublicInputs: readonly Hex[];
}
/** Structural local boundary shared by independently built native and WASM entries. */
export interface LocalWitnessAccess {
    withInputs<T>(consumer: (inputs: Record<string, unknown>) => T): T;
}
export interface ProvingRequest extends ProofStatement {
    witness: LocalWitnessAccess;
}
export interface ProverProgress {
    phase: "witness" | "proving" | "verifying" | "complete";
}
export interface ProverOptions {
    signal?: AbortSignal;
    onProgress?: (progress: ProverProgress) => void;
}
export interface Prover {
    prove(request: ProvingRequest, options?: ProverOptions): Promise<ProofBundle>;
    verify(
        bundle: ProofBundle,
        expected: ProofStatement,
        options?: ProverOptions
    ): Promise<boolean>;
}

/** Public, previously authorized recursive proof. No wallet secret or private witness is accepted. */
export interface AggregateMember {
    bundle: ProofBundle;
    statement: ProofStatement;
}
export interface AggregatorCapability {
    aggregate(members: readonly AggregateMember[], options?: ProverOptions): Promise<ProofBundle>;
}
