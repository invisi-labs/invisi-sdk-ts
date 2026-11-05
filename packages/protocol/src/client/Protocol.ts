import { Contract, getAddress, keccak256, type Provider } from "ethers";
import type { Address, Hex } from "../contracts/index";

import {
    defineDeployment,
    type ProtocolDeployment,
    type ProtocolRpcClient,
} from "@invisi-labs/rpc";
import {
    buildTransactAggregateCalldata,
    type BuildTransactAggregateCalldataParams,
} from "../funds/aggregate";
import type { ChainReader } from "../interfaces";
import { known, type DeploymentContext } from "../validation";
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
                  getProtocolVersion?(address: Address): Promise<bigint>;
                  getProtocolAddressRegistry?(address: Address): Promise<Address>;
              })
    ): Promise<void> {
        const reader =
            "getNetwork" in connection
                ? {
                      getChainId: async () => (await connection.getNetwork()).chainId,
                      getCode: async (address: Address) =>
                          (await connection.getCode(address)) as Hex,
                      getProtocolAddressRegistry: async (address: Address) =>
                          getAddress(
                              await new Contract(
                                  address,
                                  ["function addressRegistry() view returns (address)"],
                                  connection
                              ).getFunction("addressRegistry")()
                          ) as Address,
                      getProtocolVersion: async (address: Address) =>
                          BigInt(
                              await new Contract(
                                  address,
                                  ["function VERSION() view returns (uint256)"],
                                  connection
                              ).getFunction("VERSION")()
                          ),
                  }
                : connection;
        if ((await reader.getChainId()) !== this.context.chainId)
            throw new Error("deployment chain mismatch");
        const code = await reader.getCode(this.context.protocolAddress);
        if (
            !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
            (keccak256(code) as Hex) !== this.deployment.protocol.runtimeCodeHash
        )
            throw new Error("protocol runtime code profile mismatch");
        if (
            reader.getProtocolVersion &&
            (await reader.getProtocolVersion(this.context.protocolAddress)) !== 1n
        )
            throw new Error("unsupported onchain protocol version");
        const registry = this.deployment.registry;
        if (registry) {
            if (!reader.getProtocolAddressRegistry)
                throw new Error("registry binding reader capability is missing");
            if (
                getAddress(
                    await reader.getProtocolAddressRegistry(this.context.protocolAddress)
                ) !== getAddress(registry.address)
            )
                throw new Error("protocol registry binding mismatch");
            const registryCode = await reader.getCode(registry.address);
            if (
                !/^0x(?:[0-9a-fA-F]{2})+$/.test(registryCode) ||
                keccak256(registryCode) !== registry.runtimeCodeHash
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
