import type { ChainReader, ProtocolDataProvider } from "@invisi-labs/protocol";

const ttl = 30_000;
const reusable = new Set([
    "getCode",
    "getProtocolVersion",
    "getProtocolAddressRegistry",
    "getFundingNonce",
    "getCreditAllocation",
    "getCreditRevocationBitmap",
    "isKnownRoot",
    "isSpent",
    "getMembership",
]);
class RefreshPreparationSnapshot extends Error {}
export function preparationReadKey(method: string, args: readonly unknown[]): string {
    if (method === "getMembership") {
        const input = args[1] as {
            treeId: bigint;
            leafIndex: number;
            commitment: string;
            root?: string;
        };
        args = [
            args[0],
            {
                treeId: input.treeId,
                leafIndex: input.leafIndex,
                commitment: input.commitment,
                ...(input.root ? { root: input.root } : {}),
            },
            args[2],
        ];
    }
    return (
        method +
        JSON.stringify(args, (_, v) => {
            if (typeof v === "bigint") return v.toString();
            if (v && typeof v === "object" && "chainId" in v && "protocolAddress" in v)
                return {
                    chainId: String(v.chainId),
                    protocolAddress: v.protocolAddress,
                    tokenAddress: v.tokenAddress,
                };
            return v;
        })
    );
}
/** One operation's short-lived public read set. Live signing/sending readers are never replaced. */
export class PreparationReads {
    readonly #values = new Map<string, { at: number; value: Promise<unknown> }>();
    #head: { number: bigint; at: number } | undefined;
    constructor(
        readonly live: ChainReader,
        readonly rpc?: ProtocolDataProvider
    ) {}
    reader(reprice = false): ChainReader {
        const pinned =
            reprice && this.#head && performance.now() - this.#head.at < ttl
                ? this.#head
                : undefined;
        return this.adapter(this.live, pinned);
    }
    provider(reprice = false): ProtocolDataProvider | undefined {
        if (!this.rpc) return undefined;
        const pinned =
            reprice && this.#head && performance.now() - this.#head.at < ttl
                ? this.#head
                : undefined;
        return this.adapter(this.rpc, pinned);
    }
    async reprice<T>(work: (reuse: boolean) => Promise<T>): Promise<T> {
        try {
            return await work(true);
        } catch (error) {
            if (!(error instanceof RefreshPreparationSnapshot)) throw error;
            return work(false);
        }
    }
    private adapter<T extends object>(
        target: T,
        pinned: { number: bigint; at: number } | undefined
    ): T {
        const memo = this;
        return new Proxy(target, {
            get(object, name: string) {
                const fn = Reflect.get(object, name);
                if (typeof fn !== "function") return fn;
                return async (...args: unknown[]) => {
                    if (name === "getLatestBlockNumber") {
                        if (pinned) return pinned.number;
                        const number = (await fn.apply(object, args)) as bigint;
                        memo.#head = { number, at: performance.now() };
                        return number;
                    }
                    // Both framing and the final canonical-block fence remain actual chain reads.
                    if (name === "getBlock" || name === "getChainId") return fn.apply(object, args);
                    if (!reusable.has(name)) return fn.apply(object, args);
                    const key = preparationReadKey(name, args),
                        entry = memo.#values.get(key);
                    if (entry && performance.now() - entry.at < ttl)
                        return structuredClone(await entry.value);
                    // A new input requires a fresh frame, not a path queried before that input existed.
                    if (name === "getMembership" && pinned) throw new RefreshPreparationSnapshot();
                    const value = Promise.resolve()
                        .then(() => fn.apply(object, args))
                        .then((result) => structuredClone(result));
                    for (const [oldKey, old] of memo.#values)
                        if (performance.now() - old.at >= ttl) memo.#values.delete(oldKey);
                    if (memo.#values.size >= 1024)
                        memo.#values.delete(memo.#values.keys().next().value!);
                    const next = { at: performance.now(), value };
                    memo.#values.set(key, next);
                    try {
                        return structuredClone(await value);
                    } catch (error) {
                        if (memo.#values.get(key) === next) memo.#values.delete(key);
                        throw error;
                    }
                };
            },
        });
    }
}
