import { rememberProtocolConnection } from "./connections";
import { Protocol as BaseProtocol } from "@invisi-labs/protocol";
import type { ProtocolRpcClient } from "@invisi-labs/rpc";
import { getAddress, type Provider } from "ethers";
import { BroadcasterClient } from "../broadcaster/index";

const sources = new WeakMap<Protocol, Pick<ProtocolRpcClient, "getBroadcasters">>();

/** Deployment operations and token-compatible broadcaster discovery. */
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

    /** Returns enabled services that answer a token fee probe; final quotes are checked by prepared. */
    async getBroadcasters(options: { tokenAddress: string }): Promise<BroadcasterClient[]> {
        const token = getAddress(options.tokenAddress);
        if (!this.deployment.broadcasterRegistry)
            throw new Error("broadcaster registry is not configured");
        const rpc = sources.get(this);
        if (!rpc) throw new Error("broadcaster discovery requires Protocol.fromRpc");
        const clients: BroadcasterClient[] = [];
        let after: `0x${string}` | undefined;
        let block: Awaited<ReturnType<ProtocolRpcClient["getBroadcasters"]>>["block"] | undefined;
        const seen = new Set<string>();
        do {
            const page = await rpc.getBroadcasters({
                enabled: true,
                limit: 100,
                ...(after ? { after } : {}),
                ...(block ? { block } : {}),
            });
            block ??= page.block;
            const compatible = await Promise.all(
                page.broadcasters.map(async (entry) => {
                    if (!entry.enabled) return undefined;
                    try {
                        const client = new BroadcasterClient(entry);
                        await client.fee(token);
                        return client;
                    } catch {
                        return undefined;
                    }
                })
            );
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
