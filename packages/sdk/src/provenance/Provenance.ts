import {
    OfficialProvenanceClients,
    type PublicResult,
    type ProvenanceClient,
    type ProvenanceProvider,
    type Scope,
} from "@invisi-labs/core/provenance";
import {
    proveOperationProvenance,
    readOperationProvenance,
    operationProvenanceContext,
    type BroadcasterTransaction,
} from "../broadcaster/operation-bridge";
import { validateProvenanceProof, type ProvenanceProof } from "./proof-record";

export interface ProvenanceOptions {
    prover?: ProvenanceProvider;
    client?: ProvenanceClient;
    maxRootPages?: number;
    maxLeaves?: number;
}

export class Provenance {
    readonly #official = new OfficialProvenanceClients();
    constructor(private readonly options: ProvenanceOptions = {}) {}

    private async client(scope: Scope): Promise<ProvenanceClient> {
        const client =
            this.options.client ??
            (await (this.options.prover
                ? this.options.prover.getProvenanceClient(scope)
                : this.#official.get(scope)));
        if (
            BigInt(client.trust.chainId) !== BigInt(scope.chainId) ||
            BigInt(client.trust.protocolAddress) !== BigInt(scope.protocolAddress)
        )
            throw Error("Provenance client deployment mismatch");
        return client;
    }

    async prove(
        ready: BroadcasterTransaction,
        options: { reprove?: boolean } = {}
    ): Promise<ProvenanceProof> {
        const cached = options.reprove ? undefined : await readOperationProvenance(ready);
        if (cached)
            return validateProvenanceProof(cached, (await this.client(cached.context)).trust);
        const prover = this.options.prover;
        if (!prover) throw Error("NativeProver required to generate Provenance proof");
        const scope = await operationProvenanceContext(ready);
        const capability = await prover.getProvenanceCapability(scope);
        const client = await this.client(scope);
        if (capability.client !== client)
            throw Error("Provenance proving and submission clients differ");
        const proof = await proveOperationProvenance(
            ready,
            {
                ...capability,
                ...(this.options.maxRootPages === undefined
                    ? {}
                    : { maxRootPages: this.options.maxRootPages }),
                ...(this.options.maxLeaves === undefined
                    ? {}
                    : { maxLeaves: this.options.maxLeaves }),
            },
            options.reprove === true
        );
        return validateProvenanceProof(proof, client.trust);
    }

    async submit(proof: ProvenanceProof): Promise<PublicResult> {
        const copy = structuredClone(proof);
        const client = await this.client(copy.context);
        const packet = await validateProvenanceProof(copy, client.trust);
        return client.submitSourceProof(packet.data, packet.sidecars);
    }
}
