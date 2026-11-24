import type { ChainReader, ProtocolDataProvider } from "@invisi-labs/protocol";
import { TokenProtocol } from "@invisi-labs/rpc";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";

const ttl = 30_000;
const validateTokenDeployment = TokenProtocol.prototype.validateDeployment;
type DeploymentReceipt = { client: unknown; epoch: unknown; codes: Map<string, Hex> };
// Static facts belong to the infrastructure lifetime, not to each transaction.
const deploymentReceipts = new WeakMap<ChainReader, Map<string, DeploymentReceipt>>();
const reusable = new Set([
    "getCode",
    "getProtocolVersion",
    "getProtocolAddressRegistry",
    "getCreditStatus",
    "isKnownRoot",
    "isSpent",
    "getMembership",
    "getMemberships",
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
    readonly #adapters = new WeakMap<object, object>();
    readonly #values = new Map<string, { at: number; value: Promise<unknown> }>();
    #head: { number: bigint; at: number } | undefined;
    constructor(
        readonly live: ChainReader,
        readonly rpc?: ProtocolDataProvider,
        private readonly source: ChainReader = live
    ) {}

    /** Reuse only a successfully validated static binding. Transaction state and
     * payer/contract-wallet code must continue through the live submission reader.
     */
    async validateDeployment(
        protocol: TokenProtocol,
        reader: ChainReader,
        options: NonNullable<Parameters<TokenProtocol["validateDeployment"]>[1]> = {},
        source: ChainReader = this.source
    ): Promise<void> {
        const identity = Reflect.get(source, "getDeploymentValidationIdentity");
        const epoch = typeof identity === "function" ? identity.call(source) : undefined;
        if (
            source !== this.source ||
            epoch === undefined ||
            Object.getPrototypeOf(protocol) !== TokenProtocol.prototype ||
            protocol.validateDeployment !== validateTokenDeployment ||
            Reflect.get(protocol, "revocationScope") !== undefined
        ) {
            await protocol.validateDeployment(reader, options);
            return;
        }
        const key = JSON.stringify([
            String(protocol.context.chainId),
            protocol.context.protocolAddress.toLowerCase(),
            protocol.context.tokenAddress.toLowerCase(),
            protocol.expectedRuntimeCodeHash,
            options.requireRuntimeProfile ?? true,
            options.revocationFeeAmount?.toString(),
        ]);
        const deployments = deploymentReceipts.get(source) ?? new Map<string, DeploymentReceipt>();
        deploymentReceipts.set(source, deployments);
        const client = Reflect.get(source, "client");
        const observe = Reflect.get(source, "watchDeploymentValidation");
        const guard =
            typeof observe === "function"
                ? (observe.call(source) as
                      | {
                            assertUnchanged(): void;
                            close(): void;
                        }
                      | undefined)
                : undefined;
        const cached = deployments.get(key);
        const reusable =
            cached && cached.client === client && cached.epoch === epoch ? cached.codes : undefined;
        const codes = new Map<string, Hex>();
        // A receipt miss bypasses the general address-only preparation memo.
        // A snapshot upstream still supplies its deployment-bound chain ID.
        const codeReader = (this.#adapters.get(reader) as ChainReader | undefined) ?? reader;
        const deploymentReader = new Proxy(reader, {
            get(target, method) {
                if (method === "getCode")
                    return async (address: Address) => {
                        const code =
                            reusable?.get(address.toLowerCase()) ??
                            (await codeReader.getCode(address));
                        codes.set(address.toLowerCase(), code);
                        return code;
                    };
                const value = Reflect.get(target, method, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        try {
            if (reusable) {
                // The immutable configuration key already matches the successful
                // receipt; do not rehash the same deployment code on every send.
                if ((await reader.getChainId()) !== protocol.context.chainId)
                    throw Error("deployment chain mismatch");
                for (const [address, code] of reusable) codes.set(address, code);
            } else await protocol.validateDeployment(deploymentReader, options);
            guard?.assertUnchanged();
            if (client !== Reflect.get(source, "client") || epoch !== identity.call(source))
                throw Error("deployment connection changed during validation");
            // Individual successful code reads from a rejected unit are never promoted.
            if (deployments.size >= 256 && !deployments.has(key))
                deployments.delete(deployments.keys().next().value!);
            deployments.set(key, { client, epoch, codes });
        } catch (error) {
            deployments.clear();
            for (const key of this.#values.keys())
                if (key.startsWith("getCode")) this.#values.delete(key);
            throw error;
        } finally {
            guard?.close();
        }
    }
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
        const adapter = new Proxy(target, {
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
                    if ((name === "getMembership" || name === "getMemberships") && pinned)
                        throw new RefreshPreparationSnapshot();
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
        this.#adapters.set(adapter, target);
        return adapter;
    }
}
