import { LocalWallet } from "@invisi-labs/core/local";
import { ReceivingAddress } from "@invisi-labs/core";
import { hexlify } from "ethers";
import { describe, expect, it } from "vitest";
import { ProtocolRpcClient } from "../client/ProtocolRpcClient";

const owner = "0x1111111111111111111111111111111111111111";
const h = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const deployment = {
    chainId: 97n,
    protocol: { address: owner, runtimeCodeHash: h(1), fromBlock: 1n },
    registry: {
        address: "0x2222222222222222222222222222222222222222",
        runtimeCodeHash: h(2),
        fromBlock: 1n,
    },
} as const;
const block = { number: 12, hash: h(12), parentHash: h(11), timestamp: 123 };

async function fixture() {
    const wallet = await LocalWallet.fromPrivateKey(h(3));
    const keys = ReceivingAddress.parse(wallet.getAddress()).getReceivingKeys();
    return {
        ownerAddress: owner,
        viewingPublicKey: hexlify(keys.viewingPublicKey),
        clueKey: hexlify(keys.clueKey),
        nonce: "9007199254740993",
        block,
    };
}
function client(result: unknown) {
    const requests: unknown[] = [];
    return {
        requests,
        rpc: new ProtocolRpcClient({
            url: "https://example.org/v1",
            deployment,
            fetch: async (url, init) => {
                expect(String(url)).toBe("https://example.org/v1/chains/97");
                const request = JSON.parse(init!.body as string);
                requests.push(request);
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
            },
        }),
    };
}
describe("receiving-address discovery", () => {
    it("returns a validated full address with nonce and indexed block without an indexed reader", async () => {
        const data = await fixture();
        const { rpc, requests } = client(data);
        const result = await rpc.getReceivingAddress(owner);
        expect(result?.receivingAddress).toMatch(/^0i/);
        expect(result?.nonce).toBe(9007199254740993n);
        expect(result?.block.number).toBe(12n);
        expect(requests).toEqual([
            { jsonrpc: "2.0", id: 1, method: "invisi_getReceivingAddress", params: [owner] },
        ]);
    });
    it("returns null for an unregistered owner", async () => {
        expect(await client(null).rpc.getReceivingAddress(owner)).toBeNull();
    });
    it("rejects invalid identities before requesting", async () => {
        const { rpc, requests } = client(null);
        await expect(rpc.getReceivingAddress("0x1234")).rejects.toThrow();
        await expect(rpc.getReceivingAddress(`0x${"00".repeat(20)}`)).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });
    it("rejects missing registry metadata", async () => {
        const rpc = new ProtocolRpcClient({
            url: "https://example.org/v1",
            deployment: { chainId: deployment.chainId, protocol: deployment.protocol },
        });
        await expect(rpc.getReceivingAddress(owner)).rejects.toThrow(/registry/i);
    });
    it("rejects malformed or substituted registered data", async () => {
        const good = await fixture();
        for (const patch of [
            { ownerAddress: deployment.registry.address },
            { viewingPublicKey: "0x02" },
            { clueKey: h(0) },
            { nonce: -1 },
            { nonce: 9007199254740992 },
            { nonce: "18446744073709551616" },
            { block: { ...block, hash: "0x12" } },
            { block: { ...block, number: 0 } },
        ]) {
            await expect(
                client({ ...good, ...patch }).rpc.getReceivingAddress(owner)
            ).rejects.toThrow();
        }
    });
});
