import type { CanonicalBlock, ChainReader, ProtocolDataProvider } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { MissingCapabilityError } from "@invisi-labs/primitives";
import { preparationReadKey } from "./preparation-reads";

export class MissingPreparationSnapshotData extends MissingCapabilityError {
    constructor() {
        super("synchronized preparation data; refresh online or supply complete inputs");
    }
}

/** Historical facts only. A snapshot never grants permission to send a transaction. */
export interface PreparationSnapshot {
    version: 1;
    generation?: number;
    observation?: { number: bigint; hash: Hex };
    deployment: string;
    block: CanonicalBlock;
    values: Record<string, unknown>;
}
export function preparationDeployment(deployment: unknown): string {
    return JSON.stringify(deployment, (_, value) =>
        typeof value === "bigint" ? value.toString() : value
    );
}
const methods = new Set([
    "getCode",
    "getProtocolVersion",
    "getProtocolAddressRegistry",
    "getBlock",
    "getChainId",
    "getFundingNonce",
    "getCreditStatus",
    "isKnownRoot",
    "isSpent",
    "getMembership",
]);

/** Recording and replay share keys so persisted facts cannot cross block or deployment contexts. */
export function preparationSnapshotAdapter<T extends object>(
    target: T,
    snapshot: PreparationSnapshot,
    record = false
): T {
    return new Proxy(target, {
        get(object, property: string) {
            // Persisted snapshots index individual paths; keep replay on the single-path API.
            if (property === "getMemberships") return undefined;
            const fn = Reflect.get(object, property, object);
            if (property === "getLatestBlockNumber") return async () => snapshot.block.number;
            if (typeof fn !== "function") return fn;
            return async (...args: unknown[]) => {
                if (!methods.has(property))
                    throw new MissingCapabilityError(`synchronized preparation ${property}`);
                if (property === "isSpent") {
                    const [context, nullifiers, block] = args as [unknown, Hex[], CanonicalBlock];
                    if (record) {
                        const result = (await fn.apply(object, args)) as boolean[];
                        if (
                            result.length !== nullifiers.length ||
                            result.some((v) => typeof v !== "boolean")
                        )
                            throw Error("invalid spent snapshot response");
                        nullifiers.forEach((n, i) => {
                            snapshot.values[preparationReadKey(property, [context, [n], block])] =
                                result[i];
                        });
                        return [...result];
                    }
                    return nullifiers.map((n) =>
                        required(preparationReadKey(property, [context, [n], block]))
                    );
                }
                const key = preparationReadKey(property, args);
                if (record) {
                    if (Object.hasOwn(snapshot.values, key))
                        return structuredClone(snapshot.values[key]);
                    const result = await fn.apply(object, args);
                    snapshot.values[key] = structuredClone(result);
                    if (property === "getMembership") {
                        const input = args[1] as {
                            treeId: bigint;
                            leafIndex: number;
                            commitment: Hex;
                        };
                        const root = (result as { root: Hex }).root;
                        const identity = {
                            treeId: input.treeId,
                            leafIndex: input.leafIndex,
                            commitment: input.commitment,
                        };
                        snapshot.values[
                            preparationReadKey(property, [args[0], identity, args[2]])
                        ] = structuredClone(result);
                        snapshot.values[
                            preparationReadKey(property, [args[0], { ...identity, root }, args[2]])
                        ] = structuredClone(result);
                    }
                    return structuredClone(result);
                }
                return structuredClone(required(key));
            };
        },
    });
    function required(key: string): unknown {
        if (!Object.hasOwn(snapshot.values, key)) throw new MissingPreparationSnapshotData();
        return snapshot.values[key];
    }
}
export function snapshotInfrastructure(
    snapshot: PreparationSnapshot,
    reader: ChainReader,
    rpc?: ProtocolDataProvider
) {
    return {
        reader: preparationSnapshotAdapter(reader, snapshot),
        ...(rpc ? { rpc: preparationSnapshotAdapter(rpc, snapshot) } : {}),
    };
}
