import {
    ProvenanceClient,
    uint,
    word,
    type Scope,
    type ManifestIdentity,
    type OfflineProver,
} from "./index";

export interface ProvenanceCapability {
    client: ProvenanceClient;
    manifest: ManifestIdentity;
    prover: OfflineProver;
    maxRootPages?: number;
    maxLeaves?: number;
}

export interface ProvenanceProvider {
    getProvenanceClient(scope: Scope): Promise<ProvenanceClient>;
    getProvenanceCapability(scope: Scope): Promise<ProvenanceCapability>;
}

/** Bootstrap identity only over the fixed official HTTPS endpoint, then pin it for this instance. */
export class OfficialProvenanceClients {
    readonly #clients = new Map<string, Promise<ProvenanceClient>>();
    constructor(private readonly transport: typeof fetch = fetch) {}
    get(scope: Scope): Promise<ProvenanceClient> {
        const chainId = uint(scope.chainId, 64).toString();
        const protocolAddress = word(uint(scope.protocolAddress, 160));
        if (chainId === "0" || BigInt(protocolAddress) === 0n)
            throw Error("Invalid Provenance deployment");
        const key = `${chainId}/${protocolAddress}`;
        let client = this.#clients.get(key);
        if (!client) {
            client = import("./official-bootstrap")
                .then(({ bootstrapOfficialProvenance }) =>
                    bootstrapOfficialProvenance({ chainId, protocolAddress }, this.transport)
                )
                .catch((error) => {
                    this.#clients.delete(key);
                    throw error;
                });
            this.#clients.set(key, client);
        }
        return client;
    }
}
