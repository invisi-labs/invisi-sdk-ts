import { vi } from "vitest";
import { hexlify, keccak256 } from "ethers";
import { Protocol, ProtocolRpcClient } from "./index";
import { fixture } from "./session/operation-fixture";
export async function registryFixture(
    result: "registered" | "unregistered" | "failure" = "registered",
    owner: "bob" | "wallet" = "bob"
) {
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
    let state = result;
    const keys = h.bob.getReceivingAddress().getReceivingKeys();
    const cause = new Error("Registry service offline");
    const fetch = vi.fn(async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        requests.push(request.method);
        if (state === "failure") throw cause;
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
                : state === "unregistered"
                  ? null
                  : {
                        ownerAddress: h[owner].ownerAddress,
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
    return {
        h,
        reader,
        protocol,
        protocolRpc,
        requests,
        setResult: (next: typeof result) => {
            state = next;
        },
    };
}
