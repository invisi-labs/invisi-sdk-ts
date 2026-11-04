import { describe, expect, it, vi } from "vitest";
import { Wallet, ZeroAddress, ZeroHash } from "ethers";
import {
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    broadcasterTransactInterface,
    verifyBroadcasterQuote,
    BroadcasterClient,
} from "./index";
const signer = new Wallet("0x" + "11".repeat(32));
const trust = { chainId: 31337n, protocol: "0x" + "22".repeat(20), signer: signer.address };
function calldata(proof = "0x1234", signature = "0x") {
    return broadcasterTransactInterface.encodeFunctionData("transact", [
        proof,
        {
            params: {
                token: "0x" + "33".repeat(20),
                sources: [{ treeId: 0n, merkleRoot: ZeroHash }],
                nullifiers: ["0x" + "44".repeat(32)],
                outputCommitments: [],
                withdrawalAddress: signer.address,
                withdrawalAmount: 100n,
                deadline: 9999999999n,
                feeRecipient: signer.address,
                feeAmount: 2n,
            },
            deliveries: [],
            funding: {
                payer: ZeroAddress,
                amount: 0n,
                sigNonce: 0n,
                deadline: 0n,
                signature,
                permit: { deadline: 0n, v: 0, r: ZeroHash, s: ZeroHash },
            },
        },
    ]);
}
describe("broadcaster final intents", () => {
    it("rejects mismatched JSON-RPC ids and preserves RPC error codes", async () => {
        const wrong = new BroadcasterClient("https://example.org", trust, async () => ({
            jsonrpc: "2.0",
            id: 999,
            result: {},
        }));
        await expect(wrong.fee(signer.address)).rejects.toThrow("JSON-RPC response");
        const failed = new BroadcasterClient("https://example.org", trust, async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32001, message: "Unknown request" },
        }));
        await expect(failed.status("unknown")).rejects.toMatchObject({
            code: -32001,
            message: "Unknown request",
        });
        const mixed = new BroadcasterClient("https://example.org", trust, async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result: {},
            error: { code: -32000, message: "Rejected" },
        }));
        await expect(mixed.fee(signer.address)).rejects.toThrow("JSON-RPC response");
    });
    it("allows an expired signed quote to recover an exact submission's durable status", async () => {
        const data = calldata();
        const quote = {
            token: "0x" + "33".repeat(20),
            feeRecipient: signer.address,
            feeAmount: "2",
            deadline: "1",
            maxGas: "1000000",
            requestHash: broadcasterRequestHash(data),
        };
        const signed = {
            quote,
            signature: await signer.signTypedData(
                broadcasterQuoteDomain(trust),
                broadcasterQuoteTypes,
                quote
            ),
        };
        const id = "request_expired_retry_001";
        const client = new BroadcasterClient("https://example.org", trust, async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result: { id, state: "uncertain" },
        }));
        await expect(client.submit(data, signed, id)).resolves.toEqual({ id, state: "uncertain" });
        expect(() => verifyBroadcasterQuote(signed, trust, data)).toThrow();
    });
    it("hashes actual ABI calldata independently of proof and funding signature", () => {
        expect(broadcasterRequestHash(calldata())).toBe(
            broadcasterRequestHash(calldata("0x5678", "0x1234"))
        );
        expect(() => broadcasterRequestHash(calldata() + "00")).toThrow("noncanonical");
    });
    it("verifies real typed signatures and rejects cross-chain replay and fee changes", async () => {
        const data = calldata();
        const quote = {
            token: "0x" + "33".repeat(20),
            feeRecipient: signer.address,
            feeAmount: "2",
            deadline: "9999999999",
            maxGas: "1000000",
            requestHash: broadcasterRequestHash(data),
        };
        const signed = {
            quote,
            signature: await signer.signTypedData(
                broadcasterQuoteDomain(trust),
                broadcasterQuoteTypes,
                quote
            ),
        };
        expect(verifyBroadcasterQuote(signed, trust, data)).toEqual(quote);
        expect(() => verifyBroadcasterQuote(signed, { ...trust, chainId: 1n }, data)).toThrow();
        expect(() =>
            verifyBroadcasterQuote({ ...signed, quote: { ...quote, feeAmount: "3" } }, trust, data)
        ).toThrow();
    });
    it("requires HTTPS and verifies quote transport responses", async () => {
        expect(() => new BroadcasterClient("http://example.org", trust)).toThrow("HTTPS");
        const client = new BroadcasterClient("https://example.org", trust, async () => ({}));
        await expect(client.quote(calldata())).rejects.toThrow();
    });
    it("preserves registered endpoint paths and refuses redirects", async () => {
        const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: { feeRecipient: signer.address, feeAmount: "2", maxGas: "1000" },
                })
            )
        );
        try {
            const client = new BroadcasterClient("https://example.org/api/broadcaster", trust);
            await client.fee(signer.address);
            expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://example.org/api/broadcaster");
            expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
                jsonrpc: "2.0",
                id: 1,
                method: "broadcaster_getFee",
                params: { token: signer.address },
            });
            expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
        } finally {
            fetcher.mockRestore();
        }
    });
});
