import { rememberProtocolConnection } from "./connections";
import { Protocol as BaseProtocol } from "@invisi-labs/rpc";
import type { ProtocolRpcClient } from "@invisi-labs/rpc";
import { getAddress, type Provider } from "ethers";
import { BroadcasterClient } from "../broadcaster/index";

const sources = new WeakMap<Protocol, Pick<ProtocolRpcClient, "getBroadcasters">>();

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

    /** Discover token support without disclosing a transaction or requesting a price. */
    async getBroadcasters(options: {
        tokenAddress: string;
        signal?: AbortSignal;
    }): Promise<BroadcasterClient[]> {
        options.signal?.throwIfAborted();
        const token = getAddress(options.tokenAddress);
        if (BigInt(token) === 0n) throw Error("Invalid Broadcaster token address");
        if (!this.deployment.broadcasterRegistry)
            throw new Error("broadcaster registry is not configured");
        const rpc = sources.get(this);
        if (!rpc) throw new Error("broadcaster discovery requires Protocol.fromRpc");
        const clients: BroadcasterClient[] = [];
        let after: `0x${string}` | undefined;
        let block: Awaited<ReturnType<ProtocolRpcClient["getBroadcasters"]>>["block"] | undefined;
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
                ...compatible.filter((client): client is BroadcasterClient => client !== undefined)
            );
            after = page.next;
            if (after && seen.has(after)) throw new Error("repeated broadcaster pagination cursor");
            if (after) seen.add(after);
        } while (after);
        return clients;
    }
}
