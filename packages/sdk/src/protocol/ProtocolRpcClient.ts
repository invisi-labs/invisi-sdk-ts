import { ProtocolRpcClient as RpcClient } from "@invisi-labs/rpc";
import type { Provider } from "ethers";

/** Protocol RPC transport with ethers provider integration for independent chain checks. */
export class ProtocolRpcClient extends RpcClient {
    withProvider(provider: Provider): RpcClient {
        let reader: Promise<import("../integrations/ethers").EthersChainReader> | undefined;
        const resolve = () =>
            (reader ??= import("../integrations/ethers").then(
                ({ EthersChainReader }) => new EthersChainReader(provider)
            ));
        return this.withReader({
            getBlock: async (number) => (await resolve()).getBlock(number),
            getBlockByTag: async (tag) => (await resolve()).getBlockByTag(tag),
            isKnownRoot: async (...args) => (await resolve()).isKnownRoot(...args),
        });
    }
}
