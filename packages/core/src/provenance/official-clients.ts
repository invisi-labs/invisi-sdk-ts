import type { Scope, ProvenanceClient } from "./index";

/** Keep HTTPS bootstrap and rotation replay out of eager application entrypoints. */
export class OfficialProvenanceClients {
    #pool?: Promise<import("./default-client").OfficialProvenanceClients>;
    constructor(private readonly transport: typeof fetch = fetch) {}
    get(scope: Scope): Promise<ProvenanceClient> {
        this.#pool ??= import("./default-client").then(
            ({ OfficialProvenanceClients }) => new OfficialProvenanceClients(this.transport)
        );
        return this.#pool.then((pool) => pool.get(scope));
    }
}

export function officialProvenanceClient(scope: Scope): Promise<ProvenanceClient> {
    return new OfficialProvenanceClients().get(scope);
}
