import { getCircuitMetadata, getCircuitKey } from "./proof-data";
import type { ProofBundle } from "./circuit-types";
import type { Prover, ProvingRequest, ProofStatement, ProverOptions } from "./interfaces";
function check(statement: ProofStatement) {
    const metadata = getCircuitMetadata(statement.circuitName),
        key = getCircuitKey(statement.circuitName, statement.target);
    if (
        statement.artifactSha256 !== metadata.artifactSha256 ||
        statement.vkSha256 !== key.vkSha256 ||
        statement.expectedPublicInputs.length !== metadata.publicInputCount
    )
        throw new Error("proof release or statement mismatch");
}
function copyStatement<T extends ProofStatement>(statement: T): T {
    return { ...statement, expectedPublicInputs: [...statement.expectedPublicInputs] };
}
export function assertExpectedProof(bundle: ProofBundle, expected: ProofStatement): void {
    check(expected);
    if (
        bundle.circuitName !== expected.circuitName ||
        bundle.target !== expected.target ||
        bundle.artifactSha256 !== expected.artifactSha256 ||
        bundle.vkSha256 !== expected.vkSha256 ||
        bundle.publicInputs.length !== expected.expectedPublicInputs.length ||
        !bundle.publicInputs.every(
            (word, i) => BigInt(word) === BigInt(expected.expectedPublicInputs[i]!)
        )
    )
        throw new Error("proof does not match the frozen statement");
}
/** Shared orchestration; each public backend supplies one explicitly selected executor. */
export abstract class BackendProver implements Prover {
    protected abstract execute(
        request: ProvingRequest,
        options: ProverOptions
    ): Promise<ProofBundle>;
    protected abstract verifyBundle(bundle: ProofBundle, options: ProverOptions): Promise<boolean>;
    async prove(request: ProvingRequest, options: ProverOptions = {}): Promise<ProofBundle> {
        const frozen = copyStatement(request);
        check(frozen);
        options.signal?.throwIfAborted();
        options.onProgress?.({ phase: "witness" });
        let bundle: ProofBundle;
        try {
            bundle = await this.execute(frozen, options);
        } catch {
            options.signal?.throwIfAborted();
            throw new Error("Local proof execution failed");
        }
        options.signal?.throwIfAborted();
        assertExpectedProof(bundle, frozen);
        options.onProgress?.({ phase: "verifying" });
        let verified: boolean;
        try {
            verified = await this.verifyBundle(bundle, options);
        } catch {
            options.signal?.throwIfAborted();
            throw new Error("Independent proof verification failed");
        }
        if (!verified) throw new Error("Independent proof verification failed");
        options.signal?.throwIfAborted();
        options.onProgress?.({ phase: "complete" });
        return { ...bundle, publicInputs: [...bundle.publicInputs] };
    }
    async verify(
        bundle: ProofBundle,
        expected: ProofStatement,
        options: ProverOptions = {}
    ): Promise<boolean> {
        const frozen = copyStatement(expected),
            copied = { ...bundle, publicInputs: [...bundle.publicInputs] };
        options.signal?.throwIfAborted();
        assertExpectedProof(copied, frozen);
        let verified: boolean;
        try {
            verified = await this.verifyBundle(copied, options);
        } catch {
            options.signal?.throwIfAborted();
            throw new Error("Independent proof verification failed");
        }
        options.signal?.throwIfAborted();
        return verified;
    }
}
