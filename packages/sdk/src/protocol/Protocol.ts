import { rememberProtocolConnection } from "./connections";
import { Protocol as BaseProtocol } from "@invisi-labs/rpc";
import type { ProtocolRpcClient } from "@invisi-labs/rpc";
import { getAddress, type Provider } from "ethers";
import { BroadcasterClient } from "../broadcaster/index";

const sources = new WeakMap<Protocol, Pick<ProtocolRpcClient, "getBroadcasters">>();
type BroadcasterSnapshot = { clients?: readonly BroadcasterClient[] };
const broadcasterSnapshots = new WeakMap<Protocol, Map<string, BroadcasterSnapshot>>();
const MAX_BROADCASTER_SNAPSHOTS = 256;

/** Deployment operations and transaction-compatible broadcaster discovery. */
export class Protocol extends BaseProtocol {
    static override async fromRpc(
        rpc: Pick<ProtocolRpcClient, "getDeployment"> &
            Partial<Pick<ProtocolRpcClient, "getBroadcasters" | "withReader">>,
        provider: Provider,
        options: { signal?: AbortSignal } = {}
    ): Promise<Protocol> {
        const verified = await BaseProtocol.fromRpc(rpc, provider, options);
        const protocol = new Protocol({ deployment: verified.deployment });
        if (rpc.getBroadcasters)
            sources.set(protocol, rpc as Pick<ProtocolRpcClient, "getBroadcasters">);
        if (rpc.withReader)
            rememberProtocolConnection(
                protocol,
                provider,
                rpc as Pick<ProtocolRpcClient, "withReader">
            );
        return protocol;
    }

    /**
     * Discover and retain compatible broadcasters during asynchronous application startup.
     * Call again, or use getBroadcasters({ refresh: true }), to replace the snapshot.
     * Submission still verifies current service status and transaction quotes.
     */
    async initializeBroadcasters(options: {
        tokenAddress: string;
        signal?: AbortSignal;
    }): Promise<BroadcasterClient[]> {
        return this.getBroadcasters({ ...options, refresh: true });
    }

    /**
     * Discover token support without disclosing a transaction or requesting a price.
     * Uses an explicitly initialized snapshot when available; otherwise discovers afresh.
     * A refresh invalidates the previous snapshot, including when discovery fails.
     */
    async getBroadcasters(options: {
        tokenAddress: string;
        signal?: AbortSignal;
        refresh?: boolean;
    }): Promise<BroadcasterClient[]> {
        options.signal?.throwIfAborted();
        const token = getAddress(options.tokenAddress);
        if (BigInt(token) === 0n) throw Error("Invalid Broadcaster token address");
        if (!this.deployment.broadcasterRegistry)
            throw new Error("broadcaster registry is not configured");
        const rpc = sources.get(this);
        if (!rpc) throw new Error("broadcaster discovery requires Protocol.fromRpc");
        let snapshots = broadcasterSnapshots.get(this);
        const cached = snapshots?.get(token);
        if (!options.refresh && cached?.clients) return [...cached.clients];
        let snapshot: BroadcasterSnapshot | undefined;
        if (options.refresh) {
            if (!snapshots) {
                snapshots = new Map();
                broadcasterSnapshots.set(this, snapshots);
            }
            snapshot = {};
            snapshots.delete(token);
            snapshots.set(token, snapshot);
            if (snapshots.size > MAX_BROADCASTER_SNAPSHOTS)
                snapshots.delete(snapshots.keys().next().value!);
        }
        try {
            const clients: BroadcasterClient[] = [];
            let after: `0x${string}` | undefined;
            let block:
                Awaited<ReturnType<ProtocolRpcClient["getBroadcasters"]>>["block"] | undefined;
            const seen = new Set<string>();
            do {
                options.signal?.throwIfAborted();
                const page = await rpc.getBroadcasters({
                    enabled: true,
                    limit: 100,
                    ...(options.signal ? { signal: options.signal } : {}),
                    ...(after ? { after } : {}),
                    ...(block ? { block } : {}),
                });
                block ??= page.block;
                const compatible = await Promise.all(
                    page.broadcasters.map(async (entry) => {
                        if (!entry.enabled) return undefined;
                        try {
                            const client = new BroadcasterClient({
                                endpoint: entry.endpoint,
                                quoteSigner: entry.quoteSigner,
                                feeRecipient: entry.feeRecipient,
                            });
                            if (
                                !(await client.supportsToken(
                                    token,
                                    {
                                        chainId: this.context.chainId,
                                        protocol: this.context.protocolAddress,
                                    },
                                    options
                                ))
                            )
                                return undefined;
                            return client;
                        } catch {
                            options.signal?.throwIfAborted();
                            return undefined;
                        }
                    })
                );
                options.signal?.throwIfAborted();
                clients.push(
                    ...compatible.filter(
                        (client): client is BroadcasterClient => client !== undefined
                    )
                );
                after = page.next;
                if (after && seen.has(after))
                    throw new Error("repeated broadcaster pagination cursor");
                if (after) seen.add(after);
            } while (after);
            // A newer initialization/refresh owns publication even if this request finishes last.
            if (snapshot && snapshots?.get(token) === snapshot && clients.length > 0)
                snapshot.clients = [...clients];
            return clients;
        } finally {
            // Failed, cancelled, and empty refreshes must not retain token keys.
            if (snapshot && !snapshot.clients && snapshots?.get(token) === snapshot)
                snapshots.delete(token);
        }
    }
}
