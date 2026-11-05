import type { Protocol } from "@invisi-labs/protocol";
import type { ProtocolRpcClient } from "@invisi-labs/rpc";
import type { Provider } from "ethers";

/** Public network connections only; never holds wallet keys or a signer. */
const connections = new WeakMap<
    Protocol,
    { provider: Provider; protocolRpc: Pick<ProtocolRpcClient, "withReader"> }
>();
export function rememberProtocolConnection(
    protocol: Protocol,
    provider: Provider,
    protocolRpc: Pick<ProtocolRpcClient, "withReader">
): void {
    connections.set(protocol, { provider, protocolRpc });
}
export function protocolConnection(protocol: Protocol) {
    return connections.get(protocol);
}
