import type { PublicResult } from "@invisi-labs/core/provenance";
import {
    proveOperationProvenance,
    readOperationProvenance,
    type BroadcasterTransaction,
} from "../broadcaster/operation-bridge";
import type { PreparedProvenanceCapability } from "../broadcaster/provenance-preparation";
import { validateProvenanceProof, type ProvenanceProof } from "./proof-record";

export interface ProvenanceOptions extends Partial<Omit<PreparedProvenanceCapability, "client">> {
    client: PreparedProvenanceCapability["client"];
}

export class Provenance {
    constructor(private readonly options: ProvenanceOptions) {
        if (options.manifest && options.manifest.sha256 !== options.client.trust.manifestSha256)
            throw Error("Provenance manifest mismatch");
    }

    async prove(
        ready: BroadcasterTransaction,
        options: { reprove?: boolean } = {}
    ): Promise<ProvenanceProof> {
        const cached = options.reprove ? undefined : await readOperationProvenance(ready);
        if (cached) return validateProvenanceProof(cached, this.options.client.trust);
        const { manifest, prover } = this.options;
        if (!manifest || !prover)
            throw Error("Local manifest and prover required to generate Provenance proof");
        const proof = await proveOperationProvenance(
            ready,
            { ...this.options, manifest, prover },
            options.reprove === true
        );
        return validateProvenanceProof(proof, this.options.client.trust);
    }

    async submit(proof: ProvenanceProof): Promise<PublicResult> {
        const packet = await validateProvenanceProof(
            structuredClone(proof),
            this.options.client.trust
        );
        return this.options.client.submitSourceProof(packet.data, packet.sidecars);
    }
}
