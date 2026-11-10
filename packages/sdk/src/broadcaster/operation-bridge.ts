import type { PreparedProvenanceCapability } from "./provenance-preparation";
import type { ProvenanceProof } from "../provenance/proof-record";
import type { BroadcasterClient, BroadcasterStatus } from "./index";
import type { BroadcasterQuoteOptions } from "./broadcaster-preparation";

export interface BroadcasterTransaction {
    readonly id: string;
    readonly status: string;
}
interface Hooks<T extends BroadcasterTransaction> {
    quote(client: BroadcasterClient, options: BroadcasterQuoteOptions): Promise<T>;
    submit(client: BroadcasterClient): Promise<BroadcasterStatus>;
    readProvenance(): Promise<ProvenanceProof | undefined>;
    proveProvenance(
        capability: PreparedProvenanceCapability,
        reprove?: boolean
    ): Promise<ProvenanceProof>;
}
// Both stateless handles and managed sessions register their own lifecycle/storage boundary.
const bindings = new WeakMap<BroadcasterTransaction, Hooks<BroadcasterTransaction>>();
export function bindBroadcasterOperation<T extends BroadcasterTransaction>(
    target: T,
    hooks: Hooks<T>
): void {
    if (bindings.has(target)) throw Error("Broadcaster operation already registered");
    bindings.set(target, hooks);
}
export function quoteOperation<T extends BroadcasterTransaction>(
    client: BroadcasterClient,
    target: T,
    options: BroadcasterQuoteOptions
): Promise<T> {
    const hooks = bindings.get(target);
    if (!hooks) throw Error("Operation does not support broadcaster quoting");
    return hooks.quote(client, options) as Promise<T>;
}
export function submitOperation(
    client: BroadcasterClient,
    target: BroadcasterTransaction
): Promise<BroadcasterStatus> {
    const hooks = bindings.get(target);
    if (!hooks) throw Error("Operation does not support broadcaster submission");
    return hooks.submit(client);
}

export function proveOperationProvenance(
    target: BroadcasterTransaction,
    capability: PreparedProvenanceCapability,
    reprove = false
): Promise<ProvenanceProof> {
    const hooks = bindings.get(target);
    if (!hooks) throw Error("Operation does not support Provenance proving");
    return hooks.proveProvenance(capability, reprove);
}

export function readOperationProvenance(
    target: BroadcasterTransaction
): Promise<ProvenanceProof | undefined> {
    const hooks = bindings.get(target);
    if (!hooks) throw Error("Operation does not support Provenance proving");
    return hooks.readProvenance();
}
