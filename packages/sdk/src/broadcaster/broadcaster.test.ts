import { Wallet, ZeroAddress, ZeroHash } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
    BroadcasterClient,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    broadcasterTransactInterface,
    verifyBroadcasterQuote,
} from "./index";
const signer = new Wallet("0x" + "11".repeat(32));
const trust = { chainId: 31337n, protocol: "0x" + "22".repeat(20), signer: signer.address };
function calldata(proof = "0x1234", signature = "0x", feeAmount = 2n) {
    return broadcasterTransactInterface.encodeFunctionData("transact", [
        proof,
        {
            params: {
                token: "0x" + "33".repeat(20),
                sources: [{ treeId: 0n, merkleRoot: ZeroHash }],
                nullifiers: ["0x" + "44".repeat(32)],
                noteCommitments: [],
                withdrawalAddress: signer.address,
                withdrawalAmount: 100n,
                deadline: 9999999999n,
                feeRecipient: signer.address,
                feeAmount,
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
        const wrong = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            },
            async () => ({
                jsonrpc: "2.0",
                id: 999,
                result: {},
            })
        );
        await expect(wrong.estimateQuote(calldata())).rejects.toThrow("JSON-RPC response");
        const failed = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            },
            async (request) => ({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32001, message: "Unknown request" },
            })
        );
        await expect(failed.status(ZeroHash)).rejects.toMatchObject({
            code: -32001,
            message: "Unknown request",
        });
        const mixed = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            },
            async (request) => ({
                jsonrpc: "2.0",
                id: request.id,
                result: {},
                error: { code: -32000, message: "Rejected" },
            })
        );
        await expect(mixed.estimateQuote(calldata())).rejects.toThrow("JSON-RPC response");
    });
    it("encodes every operation as one positional query", async () => {
        const data = calldata();
        const quote = {
            token: "0x" + "33".repeat(20),
            feeRecipient: signer.address,
            feeAmount: "2",
            deadline: "9999999999",
            maxGas: "1000000",
            requestHash: broadcasterRequestHash(data),
            execution: "direct" as const,
        };
        const signature = await signer.signTypedData(
            broadcasterQuoteDomain(trust),
            broadcasterQuoteTypes,
            quote
        );
        const requests: { method: string; params: unknown }[] = [];
        const client = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: signer.address,
                feeRecipient: signer.address,
            },
            async (request) => {
                requests.push(request);
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32000, message: "Test response" },
                };
            }
        );
        await expect(client.estimateQuote(data)).rejects.toThrow("Test response");
        await expect(client.getQuote(data, trust)).rejects.toThrow("Test response");
        await expect(
            client.submitTransaction(data, { quote, signature, context: trust })
        ).rejects.toThrow("Test response");
        await expect(client.status("relay-owned-id")).rejects.toThrow("Test response");
        expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
            { method: "broadcaster_estimateQuote", params: [{ data }] },
            { method: "broadcaster_getQuote", params: [{ data }] },
            {
                method: "broadcaster_submitTransaction",
                params: [{ data, quote, signature }],
            },
            {
                method: "broadcaster_getTransactionStatus",
                params: [{ id: "relay-owned-id" }],
            },
        ]);
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
            execution: "direct" as const,
        };
        const signed = {
            quote,
            signature: await signer.signTypedData(
                broadcasterQuoteDomain(trust),
                broadcasterQuoteTypes,
                quote
            ),
        };
        const id = "relay-owned-id";
        const client = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            },
            async (request) => ({
                jsonrpc: "2.0",
                id: request.id,
                result: { id, state: "uncertain" },
            })
        );
        await expect(
            client.submitTransaction(data, { ...signed, context: trust })
        ).resolves.toEqual({
            id,
            state: "uncertain",
        });
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
            execution: "direct" as const,
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
        expect(
            () =>
                new BroadcasterClient({
                    endpoint: "http://example.org",
                    quoteSigner: trust.signer,
                    feeRecipient: trust.signer,
                })
        ).toThrow("HTTPS");
        const client = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            },
            async () => ({})
        );
        await expect(client.getQuote(calldata(), trust)).rejects.toThrow();
    });
    it("preserves registered endpoint paths and refuses redirects", async () => {
        const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: {
                        feeRecipient: signer.address,
                        feeAmount: "2",
                        maxGas: "1000",
                    },
                })
            )
        );
        try {
            const client = new BroadcasterClient({
                endpoint: "https://example.org/api/broadcaster",
                quoteSigner: trust.signer,
                feeRecipient: trust.signer,
            });
            await client.estimateQuote(calldata());
            expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://example.org/api/broadcaster");
            expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
                jsonrpc: "2.0",
                id: 1,
                method: "broadcaster_estimateQuote",
                params: [{ data: calldata() }],
            });
            expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
        } finally {
            fetcher.mockRestore();
        }
    });
});

it("matches all six independent canonical ABI and EIP712 cross-language vectors", async () => {
    const { readFileSync } = await import("node:fs");
    const vectors = JSON.parse(
        readFileSync(new URL("./testdata/broadcaster-v1.json", import.meta.url), "utf8")
    );
    expect(vectors).toHaveLength(6);
    for (const vector of vectors) {
        expect(broadcasterRequestHash(vector.data)).toBe(vector.requestHash);
        expect(broadcasterRequestHash(vector.unsignedVariant)).toBe(vector.requestHash);
        verifyBroadcasterQuote(
            { quote: vector.quote, signature: vector.signature },
            { ...vector.trust, chainId: BigInt(vector.trust.chainId) },
            vector.data,
            1900000000n
        );
    }
});

it("rejects zero Credit service fees and binds positive protocol fees", async () => {
    const { readFileSync } = await import("node:fs");
    const vectors = JSON.parse(
        readFileSync(new URL("./testdata/broadcaster-v1.json", import.meta.url), "utf8")
    );
    for (const vector of vectors.filter(
        (v: { method: string }) => !["transact", "shield"].includes(v.method)
    )) {
        const client = new BroadcasterClient(
            {
                endpoint: "https://example.org",
                quoteSigner: vector.trust.signer,
                feeRecipient: vector.quote.feeRecipient,
            },
            async (request) => ({
                jsonrpc: "2.0",
                id: request.id,
                result: { feeRecipient: ZeroAddress, feeAmount: "0", maxGas: "100000" },
            })
        );
        await expect(client.estimateQuote(vector.data)).rejects.toThrow(
            "invalid broadcaster estimate"
        );
        expect(() =>
            verifyBroadcasterQuote(
                { quote: { ...vector.quote, feeAmount: "0" }, signature: vector.signature },
                { ...vector.trust, chainId: BigInt(vector.trust.chainId) },
                vector.data,
                1900000000n
            )
        ).toThrow();
    }
});

import { provenanceIntentHash } from "@invisi-labs/protocol/provenance";
it("binds the provenance requirement to a signed quote and rejects downgrades", async () => {
    const data = calldata(),
        quote = {
            token: "0x" + "33".repeat(20),
            feeRecipient: signer.address,
            feeAmount: "2",
            deadline: "9999999999",
            maxGas: "1000000",
            requestHash: provenanceIntentHash(broadcasterRequestHash(data)),
            execution: "direct" as const,
        };
    const signed = {
        quote,
        signature: await signer.signTypedData(
            broadcasterQuoteDomain(trust),
            broadcasterQuoteTypes,
            quote
        ),
        provenanceRequired: true,
        requestHashFormat: "invisi-broadcaster-provenance-intent-v1",
    };
    expect(() => verifyBroadcasterQuote(signed, trust, data, 0n)).not.toThrow();
    expect(() =>
        verifyBroadcasterQuote({ ...signed, provenanceRequired: false }, trust, data, 0n)
    ).toThrow("requirement");
    const { provenanceRequired: _, ...missing } = signed;
    expect(() => verifyBroadcasterQuote(missing, trust, data, 0n)).toThrow("requirement");
    const transport = vi.fn(async (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result:
            request.method === "broadcaster_getQuote"
                ? { ...signed }
                : { id: "relay-owned-id", state: "pending" },
    }));
    const client = new BroadcasterClient(
        {
            endpoint: "https://example.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        transport
    );
    const bound = await client.getQuote(data, trust);
    await client.submitTransaction(data, bound, []);
    expect(
        (transport.mock.calls[1]![0].params as { proofSidecars: unknown[] }[])[0]!.proofSidecars
    ).toEqual([]);
});

it("requires a concrete intent and separates estimate responses from signed firm quotes", async () => {
    const transport = vi.fn(async (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { feeRecipient: signer.address, feeAmount: "2", maxGas: "1000" },
    }));
    const client = new BroadcasterClient(
        {
            endpoint: "https://example.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        transport
    );
    await expect(client.estimateQuote("")).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(await client.estimateQuote(calldata())).toEqual({
        feeRecipient: signer.address,
        feeAmount: "2",
        maxGas: "1000",
    });
    expect(transport.mock.calls[0]![0].params).toEqual([{ data: calldata() }]);
    await expect(client.getQuote(calldata(), trust)).rejects.toThrow(/quote|undefined/i);
});
it("does not accept signing or source tracking metadata in an unsigned estimate", async () => {
    const client = new BroadcasterClient(
        {
            endpoint: "https://example.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result: {
                feeRecipient: signer.address,
                feeAmount: "2",
                maxGas: "1000",
                provenanceTracking: {},
            },
        })
    );
    await expect(client.estimateQuote(calldata())).rejects.toThrow(/estimate/);
});

it("rejects unknown configuration selectors instead of ignoring them", () => {
    expect(
        () =>
            new BroadcasterClient({
                endpoint: "https://example.test",
                quoteSigner: signer.address,
                feeRecipient: signer.address,
                selector: "unused",
            } as never)
    ).toThrow("Unknown broadcaster configuration field");
});

it("treats returned IDs as opaque service-owned values", async () => {
    const opaque = "operator/acceptance:uuid-like-42";
    const transport = vi.fn(async (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { id: opaque, state: "pending" },
    }));
    const client = new BroadcasterClient(
        {
            endpoint: "https://example.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        transport
    );
    expect((await client.status(opaque)).id).toBe(opaque);
    expect(transport.mock.calls[0]![0].params).toEqual([{ id: opaque }]);
});

it("rejects unregistered operation objects before transport access", async () => {
    const transport = vi.fn(async () => {
        throw Error("unexpected transport");
    });
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        transport
    );
    const unknown = { id: "unregistered", status: "prepared" };
    expect(() => client.quote(unknown, { maxFeeAmount: 1n })).toThrow(/does not support/);
    expect(() => client.submit(unknown)).toThrow(/does not support/);
    expect(() => client.cancel(unknown)).toThrow(/does not support/);
    expect(transport).not.toHaveBeenCalled();
});
