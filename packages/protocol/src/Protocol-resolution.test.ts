import type { Hex } from "./contracts";
import { keccak256, type Provider } from "ethers";

import { describe, expect, it } from "vitest";
import { Protocol } from "./Protocol";
const address = "0x1111111111111111111111111111111111111111" as const;
const a = "0x2222222222222222222222222222222222222222" as const;
const b = "0x3333333333333333333333333333333333333333" as const;
const deployment = {
    chainId: 31337n,
    protocol: { address: address, runtimeCodeHash: keccak256("0x6000") as Hex, fromBlock: 0n },
};
describe("direct multi-token deployment", () => {
    it("uses the same protocol for different assets", () => {
        const p = new Protocol({ deployment });
        expect(p.forToken(a).context).toEqual({
            chainId: 31337n,
            protocolAddress: address,
            tokenAddress: a,
        });
        expect(p.forToken(b).context.protocolAddress).toBe(address);
    });
    it("accepts an unconfigured token without registration or a Factory lookup", async () => {
        const p = new Protocol({ deployment });
        const reader = {
            getChainId: async () => 31337n,
            getCode: async () => "0x6000" as const,
        };
        await expect(p.forToken(a).validateDeployment(reader)).resolves.toBeUndefined();
    });
    it("rejects a token without contract code", async () => {
        const p = new Protocol({ deployment });
        const reader = {
            getChainId: async () => 31337n,
            getCode: async (target: string) =>
                target === address ? ("0x6000" as const) : ("0x" as const),
        };
        await expect(p.forToken(a).validateDeployment(reader)).rejects.toThrow(/token.*contract/);
    });
    it("rejects a different chain or runtime", async () => {
        const p = new Protocol({ deployment });
        await expect(
            p.validateDeployment({
                getChainId: async () => 1n,
                getCode: async () => "0x6000" as Hex,
            })
        ).rejects.toThrow(/chain/);
        await expect(
            p.validateDeployment({
                getChainId: async () => 31337n,
                getCode: async () => "0x6001" as Hex,
            })
        ).rejects.toThrow(/runtime/);
    });
    it("rejects zero token and stale constructor options", () => {
        const p = new Protocol({ deployment });
        expect(() => p.forToken("0x0000000000000000000000000000000000000000")).toThrow();
        expect(() => new Protocol({ ...{ deployment }, operator: a } as never)).toThrow(
            /unsupported/
        );
    });
});

it("accepts onchain Protocol version 1 and rejects version 2 when the reader provides it", async () => {
    const p = new Protocol({ deployment });
    const reader = {
        getChainId: async () => 31337n,
        getCode: async () => "0x6000" as Hex,
        getProtocolVersion: async () => 2n,
    };
    await expect(p.validateDeployment(reader)).rejects.toThrow(/onchain protocol version/);
    reader.getProtocolVersion = async () => 1n;
    await expect(p.validateDeployment(reader)).resolves.toBeUndefined();
});

describe("Protocol.fromRpc", () => {
    const provider = {
        getNetwork: async () => ({ chainId: 31337n }),
        getCode: async () => "0x6000",
        call: async () => `0x${"1".padStart(64, "0")}`,
    } as unknown as Provider;
    it("uses the selected service and chain and retains immutable contract pins", async () => {
        const controller = new AbortController();
        const rpc = {
            async getDeployment(chainId: bigint, options?: { signal?: AbortSignal }) {
                expect(chainId).toBe(31337n);
                expect(options?.signal).toBe(controller.signal);
                return deployment;
            },
        };
        const protocol = await Protocol.fromRpc(rpc, provider, { signal: controller.signal });
        expect(protocol.context).toEqual({ chainId: 31337n, protocolAddress: address });
        expect(protocol.deployment.protocol.runtimeCodeHash).toBe(
            deployment.protocol.runtimeCodeHash
        );
        expect(Object.isFrozen(protocol.deployment.protocol)).toBe(true);
        expect(protocol.forToken(a).context.tokenAddress).toBe(a);
    });

    it("rejects a mismatched chain even when a custom service returns it", async () => {
        const rpc = { getDeployment: async () => ({ ...deployment, chainId: 1n }) };
        await expect(Protocol.fromRpc(rpc, provider)).rejects.toThrow(/chain mismatch/);
    });

    it("does not fall back when deployment lookup fails", async () => {
        const error = new Error("service unavailable");
        const rpc = {
            getDeployment: async () => {
                throw error;
            },
        };
        await expect(Protocol.fromRpc(rpc, provider)).rejects.toBe(error);
        await expect(
            Protocol.fromRpc(rpc, {
                ...provider,
                getNetwork: async () => ({ chainId: 0n }),
            } as Provider)
        ).rejects.toThrow(/chainId/);
    });
});

it("fromRpc rejects incorrect contract code before returning a protocol", async () => {
    await expect(
        Protocol.fromRpc({ getDeployment: async () => deployment }, {
            getNetwork: async () => ({ chainId: 31337n }),
            getCode: async () => "0x6001",
        } as unknown as Provider)
    ).rejects.toThrow(/runtime/);
});

it("authenticates the Protocol's immutable registry against its selected deployment profile", async () => {
    const p = new Protocol({
        deployment: { ...deployment, registry: { ...deployment.protocol, address: a } },
    });
    const reader = {
        getChainId: async () => 31337n,
        getCode: async () => "0x6000" as Hex,
        getProtocolAddressRegistry: async () => b,
    };
    await expect(p.validateDeployment(reader)).rejects.toThrow(/registry binding/);
    reader.getProtocolAddressRegistry = async () => a as typeof b;
    await expect(p.validateDeployment(reader)).resolves.toBeUndefined();
    await expect(
        p.validateDeployment({ getChainId: reader.getChainId, getCode: reader.getCode })
    ).rejects.toThrow(/registry.*capability/);
    await expect(
        p.validateDeployment({
            ...reader,
            getCode: async (target: Hex) => (target === a ? "0x6001" : "0x6000"),
        })
    ).rejects.toThrow(/registry runtime/);
});
