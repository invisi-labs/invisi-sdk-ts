import { ProtocolRpcClient as RpcClient } from "@invisi-labs/rpc";
import type { Provider } from "ethers";
import { EthersChainReader } from "../integrations/ethers";

/** Protocol RPC transport with ethers provider integration for independent chain checks. */
export class ProtocolRpcClient extends RpcClient {
    withProvider(provider: Provider): RpcClient {
        return this.withReader(new EthersChainReader(provider));
    }
}
