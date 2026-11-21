import { Contract, getAddress, keccak256, type Provider } from "ethers";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";

import { defineDeployment, type ProtocolDeployment, type ProtocolRpcClient } from "../../index";
import {
    buildTransactAggregateCalldata,
    type BuildTransactAggregateCalldataParams,
} from "@invisi-labs/protocol";
import type { CanonicalBlock, ChainReader } from "@invisi-labs/protocol";
import { known, type DeploymentContext } from "@invisi-labs/protocol";
import { TokenProtocol } from "./TokenProtocol";

export interface ProtocolOptions {
    deployment: ProtocolDeployment;
}

/** A multi-token deployment. Asset support is always read from the chain. */
export class Protocol {
    readonly deployment: Readonly<ProtocolDeployment>;
    readonly context: Readonly<DeploymentContext>;

    constructor(options: ProtocolOptions) {
        known(options, ["deployment"], "protocol options");
        this.deployment = defineDeployment(options.deployment);
        this.context = Object.freeze({
            chainId: this.deployment.chainId,
            protocolAddress: this.deployment.protocol.address,
        });
        Object.freeze(this);
    }

    /** Load the selected deployment and verify its contract against Chain RPC before returning. */
    static async fromRpc(
        rpc: Pick<ProtocolRpcClient, "getDeployment">,
        provider: Provider,
        options: { signal?: AbortSignal } = {}
    ): Promise<Protocol> {
        const chainId = (await provider.getNetwork()).chainId;
        if (typeof chainId !== "bigint" || chainId <= 0n || chainId >= 1n << 64n)
            throw new Error("invalid protocol chainId");
        const deployment = await rpc.getDeployment(
            chainId,
            options.signal ? { signal: options.signal } : {}
        );
        const protocol = new Protocol({ deployment });
        if (protocol.context.chainId !== chainId) throw new Error("RPC deployment chain mismatch");
        await protocol.validateDeployment(provider);
        return protocol;
    }

    async validateDeployment(
        connection:
            | Provider
            | (Pick<ChainReader, "getChainId" | "getCode"> & {
                  getProtocolVersion?(address: Address, block?: CanonicalBlock): Promise<bigint>;
                  getProtocolAddressRegistry?(
                      address: Address,
                      block?: CanonicalBlock
                  ): Promise<Address>;
              }),
        block?: CanonicalBlock
    ): Promise<void> {
        const reader =
            "getNetwork" in connection
                ? {
                      getChainId: async () => (await connection.getNetwork()).chainId,
                      getCode: async (address: Address, at?: CanonicalBlock) =>
                          (await connection.getCode(address, at?.number)) as Hex,
                      getProtocolAddressRegistry: async (address: Address, at?: CanonicalBlock) =>
                          getAddress(
                              await new Contract(
                                  address,
                                  ["function addressRegistry() view returns (address)"],
                                  connection
                              ).getFunction("addressRegistry")(
                                  ...(at ? [{ blockTag: at.number }] : [])
                              )
                          ) as Address,
                      getProtocolVersion: async (address: Address, at?: CanonicalBlock) =>
                          BigInt(
                              await new Contract(
                                  address,
                                  ["function VERSION() view returns (uint256)"],
                                  connection
                              ).getFunction("VERSION")(...(at ? [{ blockTag: at.number }] : []))
                          ),
                  }
                : connection;
        const [chainId, code] = await Promise.all([
            reader.getChainId(),
            reader.getCode(this.context.protocolAddress, ...(block ? [block] : [])),
        ]);
        if (chainId !== this.context.chainId) throw new Error("deployment chain mismatch");
        if (
            !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
            (keccak256(code) as Hex) !== this.deployment.protocol.runtimeCodeHash
        )
            throw new Error("protocol runtime code profile mismatch");
        const registry = this.deployment.registry;
        if (registry && !reader.getProtocolAddressRegistry)
            throw new Error("registry binding reader capability is missing");
        const [version, binding, registryCode] = await Promise.all([
            reader.getProtocolVersion?.(this.context.protocolAddress, ...(block ? [block] : [])),
            registry
                ? reader.getProtocolAddressRegistry!(
                      this.context.protocolAddress,
                      ...(block ? [block] : [])
                  )
                : undefined,
            registry ? reader.getCode(registry.address, ...(block ? [block] : [])) : undefined,
        ]);
        if (reader.getProtocolVersion && version !== 1n)
            throw new Error("unsupported onchain protocol version");
        if (registry) {
            if (getAddress(binding!) !== getAddress(registry.address))
                throw new Error("protocol registry binding mismatch");
            if (
                !/^0x(?:[0-9a-fA-F]{2})+$/.test(registryCode!) ||
                keccak256(registryCode!) !== registry.runtimeCodeHash
            )
                throw new Error("registry runtime code profile mismatch");
        }
    }

    aggregate(request: Omit<BuildTransactAggregateCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildTransactAggregateCalldata({ ...request, context: this.context }),
        };
    }

    /** Build an operation context for one asset within this same deployment. */
    forToken(tokenAddress: Address): TokenProtocol {
        return new TokenProtocol(
            { ...this.context, tokenAddress: getAddress(tokenAddress) as Hex },
            { expectedRuntimeCodeHash: this.deployment.protocol.runtimeCodeHash }
        );
    }
}
