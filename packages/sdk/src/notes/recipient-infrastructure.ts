import {
    MissingCapabilityError,
    ReceivingAddress,
    type ReceivingKeyLookup,
} from "@invisi-labs/core";
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { EthersAddressResolver } from "../integrations/ethers";
import type { TransactionInfrastructure } from "../transactions/operation-types";

export type AddressLookup = "chain" | "protocol-rpc";
const recipientInfrastructure = Symbol("SDK recipient infrastructure");
type InternalInfrastructure = {
    [recipientInfrastructure]?: (source: AddressLookup) => ReceivingKeyLookup;
};

/** Capture deployment pins before a Protocol is bound to an operation's token. */
export function configureRecipientInfrastructure<T extends TransactionInfrastructure>(
    options: T
): T {
    const { provider, protocolRpc, chainReader } = options;
    const registry = options.protocol.deployment.registry;
    const deployment = options.protocol.deployment;
    const lookup =
        (source: AddressLookup): ReceivingKeyLookup =>
        async (ownerAddress) => {
            if (!registry) throw new MissingCapabilityError("receiving-key registry deployment");
            if (source === "chain") {
                if (!provider)
                    throw new MissingCapabilityError("ethers provider for registry lookup");
                return new EthersAddressResolver(
                    provider,
                    {
                        chainId: deployment.chainId,
                        registryAddress: registry.address,
                    },
                    registry.runtimeCodeHash
                ).lookup(ownerAddress);
            }
            if (!(protocolRpc instanceof ProtocolRpcClient))
                throw new MissingCapabilityError("Protocol RPC recipient discovery");
            const rpc = chainReader ? protocolRpc.withReader(chainReader) : protocolRpc;
            const discovered = await rpc.getDeployment(deployment.chainId);
            if (
                discovered.protocol.address !== deployment.protocol.address ||
                discovered.protocol.runtimeCodeHash !== deployment.protocol.runtimeCodeHash ||
                discovered.protocol.fromBlock !== deployment.protocol.fromBlock ||
                discovered.registry?.address !== registry.address ||
                discovered.registry.runtimeCodeHash !== registry.runtimeCodeHash ||
                discovered.registry.fromBlock !== registry.fromBlock
            )
                throw new Error("Recipient registry deployment pins mismatch");
            const registration = await rpc.getReceivingAddress(ownerAddress);
            return registration
                ? ReceivingAddress.parse(registration.receivingAddress).getReceivingKeys()
                : null;
        };
    return { ...options, [recipientInfrastructure]: lookup };
}

/** Internal lookup plumbing; public APIs never accept resolver functions. */
export function recipientLookup(
    options: object,
    source: AddressLookup = "protocol-rpc"
): ReceivingKeyLookup {
    return async (ownerAddress) => {
        const lookup = (options as InternalInfrastructure)[recipientInfrastructure];
        if (!lookup) throw new MissingCapabilityError("recipient infrastructure");
        return lookup(source)(ownerAddress);
    };
}
