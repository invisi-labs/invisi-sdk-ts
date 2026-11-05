import { getBytes, hexlify } from "ethers";
import { expect, it } from "vitest";
import { decodePaymentRequest, encodePaymentRequest } from "./codec";
import vectors from "./testdata/requests.json";
import type { PaymentRequest } from "./types";

it.each(vectors.vectors)("matches Python binary/Base64URL vector $name", (vector) => {
    const raw = vector.request;
    const request = {
        ...raw,
        chainId: BigInt(raw.chainId),
        amount: BigInt(raw.amount),
        recipient: {
            ...raw.recipient,
            ...("nonce" in raw.recipient ? { nonce: BigInt(raw.recipient.nonce!) } : {}),
        },
        ...("payload" in raw ? { payload: getBytes(raw.payload!) } : {}),
    } as PaymentRequest;
    expect(encodePaymentRequest(request)).toBe(vector.encoded);
    expect(encodePaymentRequest(decodePaymentRequest(vector.encoded))).toBe(vector.encoded);
    const text = vector.encoded.slice(4);
    const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0)
    );
    expect(hexlify(bytes)).toBe("0x" + vector.binaryHex);
    expect(bytes.length).toBe(vector.binaryLength);
});

it("rejects invalid versions, discriminants, presence flags, fields and declared lengths", () => {
    const source = getBytes("0x" + vectors.vectors[0]!.binaryHex);
    const encode = (data: Uint8Array) =>
        "ipr:" +
        btoa(String.fromCharCode(...data))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    for (const [position, value] of [
        [0, 0],
        [0, 2],
        [1, 0],
        [1, 4],
        [86, 2],
        [87, 2],
    ]) {
        const data = source.slice();
        data[position!] = value!;
        expect(() => decodePaymentRequest(encode(data))).toThrow();
    }
    const field = getBytes("0x" + vectors.vectors[6]!.binaryHex);
    field.fill(255, 66);
    expect(() => decodePaymentRequest(encode(field))).toThrow();
    const payload = getBytes("0x" + vectors.vectors[2]!.binaryHex);
    payload[payload.length - 1] = 1;
    expect(() => decodePaymentRequest(encode(payload))).toThrow();
    const valid = vectors.vectors[0]!.encoded;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(valid.at(-1)!);
    expect(() => decodePaymentRequest(valid.slice(0, -1) + alphabet[index + 1])).toThrow();
});
