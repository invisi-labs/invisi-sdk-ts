import { OfficialProvenanceClients, type ProvenanceClient } from "@invisi-labs/rpc/provenance";
import { type PublicResult, type Scope } from "@invisi-labs/protocol/provenance";
import { type ProvenanceProvider } from "@invisi-labs/prover/provenance-witness";
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
        const client = this.options.client ?? (await this.#official.get(scope));
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
        const capability = await prover.getProvenanceCapability();
        const client = await this.client(scope);
        const proof = await proveOperationProvenance(
            ready,
            {
                ...capability,
                client,
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
