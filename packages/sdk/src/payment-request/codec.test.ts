import { FIELD_MODULUS, Wallet } from "@invisi-labs/core";
import { getBytes } from "ethers";
import { describe, expect, it } from "vitest";
import { decodePaymentRequest, encodePaymentRequest } from "./codec";
import type { PaymentRequest } from "./types";

const context = {
    chainId: 97n,
    protocolAddress: `0x${"11".repeat(20)}` as const,
    tokenAddress: `0x${"22".repeat(20)}` as const,
    amount: 70n,
};
const owner = `0x${"33".repeat(20)}` as const;
const address = (await Wallet.fromPrivateKey(`0x${"01".repeat(32)}`)).getAddress();
const requests: PaymentRequest[] = [
    { ...context, recipient: { type: "evm", address: owner, envelope: false } },
    { ...context, recipient: { type: "evm", address: owner } },
    { ...context, recipient: { type: "invisi", address } },
    { ...context, recipient: { type: "identity", identity: `0x${"00".repeat(31)}01` } },
];

describe("canonical Note payment request encoding", () => {
    it.each(requests)("roundtrips $recipient.type without choosing a nonce", (request) => {
        const encoded = encodePaymentRequest(request);
        const recovered = decodePaymentRequest(encoded);
        expect(encoded).toMatch(/^ipr:[A-Za-z0-9_-]+$/);
        expect(encodePaymentRequest(recovered)).toBe(encoded);
        expect(recovered.recipient).not.toHaveProperty("nonce");
    });
    it("uses the specified big-endian layout and exact lengths", () => {
        const encoded = encodePaymentRequest(requests[0]!);
        const bytes = Uint8Array.from(
            atob(encoded.slice(4).replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0)
        );
        expect(bytes.length).toBe(88);
        expect(bytes.slice(0, 10)).toEqual(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 97]));
        expect(bytes.slice(10, 30)).toEqual(getBytes(context.protocolAddress));
        expect(bytes.slice(50, 66)).toEqual(new Uint8Array([...Array(15).fill(0), 70]));
        expect(requests.map((r) => encodePaymentRequest(r).length)).toEqual([122, 124, 210, 135]);
    });
    it("encodes nonce zero as present and omits local lookup policy", () => {
        const request = {
            ...context,
            recipient: {
                type: "evm" as const,
                address: owner,
                nonce: 0n,
                addressLookup: "chain" as const,
            },
        };
        const encoded = encodePaymentRequest(request);
        expect(decodePaymentRequest(encoded).recipient).toMatchObject({ nonce: 0n });
        expect(decodePaymentRequest(encoded).recipient).not.toHaveProperty("addressLookup");
        expect(
            encodePaymentRequest({
                ...request,
                recipient: { ...request.recipient, addressLookup: "protocol-rpc" },
            })
        ).toBe(encoded);
    });
    it("preserves arbitrary payload bytes and fixed nonces", () => {
        const request: PaymentRequest = {
            ...context,
            recipient: { type: "invisi", address, nonce: FIELD_MODULUS - 1n },
            payload: new Uint8Array([0, 255, 128]),
        };
        expect(decodePaymentRequest(encodePaymentRequest(request))).toEqual(request);
    });
    it("rejects invalid material and forbidden or unknown fields", () => {
        for (const request of [
            { ...requests[0], chainId: 1n << 64n },
            { ...requests[0], amount: 1n << 128n },
            { ...requests[0], amount: 0n },
            { ...requests[0], payload: new Uint8Array() },
            { ...requests[1], payload: new Uint8Array(3937) },
            { ...requests[1], recipient: { type: "evm", address: owner, nonce: FIELD_MODULUS } },
            {
                ...requests[3],
                recipient: { type: "identity", identity: `0x${"00".repeat(31)}01`, nonce: 0n },
            },
            { ...requests[2], recipient: { type: "invisi", address, envelope: true } },
            { ...requests[0], spendingPrivateKey: "secret" },
        ])
            expect(() => encodePaymentRequest(request as PaymentRequest)).toThrow();
    });
    it("rejects wrong prefixes, padding, noncanonical base64, truncation and trailing data", () => {
        const valid = encodePaymentRequest(requests[0]!);
        for (const bad of [
            valid.replace("ipr:", "ipn:"),
            valid + "=",
            valid + "AA",
            valid.slice(0, -3),
            "ipr:",
            "ipr:____",
        ]) {
            expect(() => decodePaymentRequest(bad)).toThrow();
        }
    });
});

it("roundtrips the maximum complete Invisi request within the exact resource cap", () => {
    const request: PaymentRequest = {
        ...context,
        chainId: (1n << 64n) - 1n,
        amount: (1n << 128n) - 1n,
        recipient: { type: "invisi", address, nonce: FIELD_MODULUS - 1n },
        payload: Uint8Array.from({ length: 3936 }, (_, i) => i % 256),
    };
    const encoded = encodePaymentRequest(request);
    expect(encoded.length).toBe(5500);
    expect(decodePaymentRequest(encoded)).toEqual(request);
    expect(() => decodePaymentRequest("ipr:" + "A".repeat(6000))).toThrow();
});
