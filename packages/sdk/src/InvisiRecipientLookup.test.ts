import { invisiAddressRegistryAbi } from "@invisi-labs/protocol/contracts";
import { describe, expect, it, vi } from "vitest";
import { Interface, type Provider, hexlify, keccak256 } from "ethers";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient } from "./index";
import { fixture } from "./session/operation-fixture";

async function setup(result: "registered" | "unregistered" | "failure" = "registered") {
    const h = await fixture();
    const deployment = {
        ...h.protocol.deployment,
        registry: {
            address: "0x3333333333333333333333333333333333333333" as const,
            runtimeCodeHash: keccak256("0x6000") as `0x${string}`,
            fromBlock: 0n,
        },
    };
    const protocol = new Protocol({ deployment });
    const reader = {
        ...h.reader,
        getProtocolAddressRegistry: async () => deployment.registry.address,
    };
    const requests: string[] = [];
    const keys = h.bob.getReceivingAddress().getReceivingKeys();
    const cause = new Error("Registry service offline");
    const fetch = vi.fn(async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        requests.push(request.method);
        if (result === "failure") throw cause;
        const value =
            request.method === "invisi_getDeployment"
                ? {
                      apiVersion: "v1",
                      protocolVersion: "1",
                      deployment: JSON.parse(
                          JSON.stringify(deployment, (_, v) =>
                              typeof v === "bigint" ? v.toString() : v
                          )
                      ),
                  }
                : result === "unregistered"
                  ? null
                  : {
                        walletIdentity: h.bob.ownerAddress,
                        viewingPublicKey: hexlify(keys.viewingPublicKey),
                        clueKey: hexlify(keys.clueKey),
                        nonce: "1",
                        block: {
                            number: 12,
                            hash: `0x${"00".repeat(31)}0c`,
                            parentHash: `0x${"00".repeat(31)}0b`,
                            timestamp: 2000000000,
                        },
                    };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }));
    }) as unknown as typeof globalThis.fetch;
    const protocolRpc = new ProtocolRpcClient({ url: "https://example.org/v1", deployment, fetch });
    return { h, reader, protocol, protocolRpc, requests };
}

describe("Invisi recipient lookup selection", () => {
    it.each(["registered", "unregistered", "failure"] as const)(
        "defaults to Protocol RPC for %s owners with no direct-chain fallback",
        async (result) => {
            const { h, reader, protocol, protocolRpc, requests } = await setup(result);
            const invisi = new Invisi({
                chainReader: reader,
                protocolRpc,
            });
            const pending = invisi.prepareShield({
                wallet: h.wallet,
                protocol,
                tokenAddress: h.context.tokenAddress,
                outputs: [{ to: h.bob.ownerAddress, amount: 1n }],
                funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
            });
            if (result === "registered") {
                expect((await pending).preview().outputs[0]?.to).toBe(h.bob.ownerAddress);
                expect(requests).toEqual(["invisi_getDeployment", "invisi_getReceivingAddress"]);
            } else {
                const error = await pending.catch((error: unknown) => error);
                expect(error).toBeInstanceOf(InvisiError);
                expect(error).toMatchObject({
                    code:
                        result === "unregistered"
                            ? "EVM_ADDRESS_NOT_REGISTERED"
                            : "RECIPIENT_LOOKUP_FAILED",
                    outputIndex: 0,
                    address: h.bob.ownerAddress,
                });
            }
        }
    );
    it("accepts a full 0i address without registration or a working registry service", async () => {
        const { h, reader, protocol, protocolRpc, requests } = await setup("failure");
        await new Invisi({
            chainReader: reader,
            protocolRpc,
            addressLookup: "protocol-rpc",
        }).prepareShield({
            wallet: h.wallet,
            protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.getAddress(), amount: 1n }],
            funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        });
        expect(requests).toEqual([]);
    });

    it("does not require an unused Protocol RPC client for full addresses", async () => {
        const { h, reader, protocol } = await setup();
        await new Invisi({ chainReader: reader, addressLookup: "protocol-rpc" }).prepareShield({
            wallet: h.wallet,
            protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.getAddress(), amount: 1n }],
            funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        });
    });

    it("honors an explicit resolver without contacting Protocol RPC", async () => {
        const { h, reader, protocol, protocolRpc, requests } = await setup("failure");
        const invisi = new Invisi({
            chainReader: reader,
            protocolRpc,
            addressLookup: "protocol-rpc",
            addressResolver: async () => h.bob.getReceivingAddress().getReceivingKeys(),
        });
        await invisi.prepareShield({
            wallet: h.wallet,
            protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.ownerAddress, amount: 1n }],
            funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        });
        expect(requests).toEqual([]);
    });
    it("allows direct chain lookup instead of the default Protocol RPC", async () => {
        const { h, reader, protocol, protocolRpc, requests } = await setup("failure");
        const abi = new Interface(invisiAddressRegistryAbi);
        const keys = h.bob.getReceivingAddress().getReceivingKeys();
        const call = vi.fn(async (request: { data: string }) => {
            const decoded = abi.parseTransaction({ data: request.data })!;
            return decoded.name === "isRegistered"
                ? abi.encodeFunctionResult("isRegistered", [true])
                : abi.encodeFunctionResult("receivingKeysOf", [
                      [keys.viewingPublicKey, keys.clueKey],
                      1n,
                  ]);
        });
        const provider = {
            getNetwork: async () => ({ chainId: protocol.context.chainId }),
            getCode: async () => "0x6000",
            getBlock: async () => ({ number: 12, hash: `0x${"12".repeat(32)}` }),
            call,
            resolveName: async (name: string) => name,
        } as unknown as Provider;
        await new Invisi({
            provider,
            chainReader: reader,
            protocolRpc,
            addressLookup: "chain",
        }).prepareShield({
            wallet: h.wallet,
            protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.ownerAddress, amount: 1n }],
            funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        });
        expect(call).toHaveBeenCalledTimes(2);
        expect(requests).toEqual([]);
    });
});
