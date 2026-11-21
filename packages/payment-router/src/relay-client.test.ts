import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getAddress, Interface, Signature, Wallet, type Authorization } from "ethers";
import {
    PaymentRouterRelayClient,
    verifyRouterBroadcasterQuote,
    routerBroadcasterQuoteDomain,
    routerBroadcasterQuoteTypes,
    type RouterRelayInput,
    type RouterBroadcasterTrust,
    type SignedRouterBroadcasterQuote,
} from "./relay-client";
import { paymentRouterAbi, paymentRouterAccountAbi } from "./canonical-abi";
import { hashRelayEnvelope } from "./canonical";
import type { Hex } from "@invisi-labs/protocol/contracts";
const intentVectors = JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/intent-vectors.json", import.meta.url),
        "utf8"
    )
);
const envelopes = JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/envelope-vectors.json", import.meta.url),
        "utf8"
    )
);
const signer = new Wallet("0x" + "01".padStart(64, "0"));
const trust: RouterBroadcasterTrust = {
    chainId: 31337n,
    core: intentVectors.addresses.core,
    quoteSigner: signer.address as Hex,
    feeRecipient: intentVectors.addresses.relayer,
};
function inputFor(vector: any): RouterRelayInput {
    return {
        coreCalldata: intentVectors.cases[0].coreCalldata,
        outer: { ...vector.envelope, value: 0n },
        ...(vector.envelope.authorizationList
            ? {
                  authorizationList: vector.envelope.authorizationList.map((a: any) => ({
                      address: a.address,
                      chainId: BigInt(a.chainId),
                      nonce: BigInt(a.nonce),
                      signature: Signature.from({
                          r: a.r,
                          s: a.s,
                          yParity: Number(BigInt(a.yParity)) as 0 | 1,
                      }),
                  })) as Authorization[],
              }
            : {}),
    };
}
async function signedFor(input: RouterRelayInput): Promise<SignedRouterBroadcasterQuote> {
    const quote = {
        token: intentVectors.addresses.token,
        feeRecipient: trust.feeRecipient,
        feeAmount: "200000",
        deadline: "1900000000",
        maxGas: "1000000",
        requestHash: hashRelayEnvelope(
            trust.chainId,
            trust.core,
            input.outer,
            input.authorizationList
        ),
        execution: "direct" as const,
    };
    return {
        quote,
        requestHashFormat: "payment-router-envelope-v1",
        signature: (await signer.signTypedData(
            routerBroadcasterQuoteDomain(trust),
            routerBroadcasterQuoteTypes,
            quote
        )) as Hex,
    };
}
describe("dedicated Router Broadcaster RPC", () => {
    for (const vector of envelopes)
        it(
            "estimates, verifies and submits " + vector.name + " with envelope wire fields",
            async () => {
                const input = inputFor(vector),
                    signed = await signedFor(input),
                    calls: any[] = [];
                const client = new PaymentRouterRelayClient({
                    endpoint: "https://broadcaster.example",
                    trust,
                    transport: async (req) => {
                        calls.push(structuredClone(req));
                        return {
                            jsonrpc: "2.0",
                            id: req.id,
                            result:
                                req.method === "broadcaster_getQuote"
                                    ? signed
                                    : req.method === "broadcaster_estimateQuote"
                                      ? {
                                            feeRecipient: trust.feeRecipient,
                                            feeAmount: "200000",
                                            maxGas: "1000000",
                                        }
                                      : { id: "submission-1", state: "pending" },
                        };
                    },
                });
                expect((await client.estimateQuote(input)).feeAmount).toBe("200000");
                const result = await client.getQuote(input);
                expect((await client.submitTransaction(input, result)).id).toBe("submission-1");
                expect(calls.map((c) => c.method)).toEqual([
                    "broadcaster_estimateQuote",
                    "broadcaster_getQuote",
                    "broadcaster_submitTransaction",
                ]);
                for (const call of calls) {
                    expect(call.params).toHaveLength(1);
                    expect(call.params[0].data).toBe(input.coreCalldata);
                    expect(call.params[0].router).toEqual({
                        ...vector.envelope,
                        to: getAddress(vector.envelope.to),
                    });
                }
                expect(Object.keys(calls[2].params[0]).sort()).toEqual([
                    "data",
                    "quote",
                    "router",
                    "signature",
                ]);
            }
        );
    it("rejects all signed quote field, signer, domain, execution and expiry substitutions", async () => {
        const input = inputFor(envelopes[0]),
            signed = await signedFor(input);
        expect(verifyRouterBroadcasterQuote(signed, trust, input, 1800000000n)).toEqual(
            signed.quote
        );
        for (const provenanceRequired of [true, false])
            expect(
                verifyRouterBroadcasterQuote(
                    { ...signed, provenanceRequired },
                    trust,
                    input,
                    1800000000n
                )
            ).toEqual(signed.quote);
        const variants = [
            { ...signed, requestHashFormat: "ordinary" },
            { ...signed, provenanceRequired: "true" },
            { ...signed, quote: { ...signed.quote, execution: "aggregate" } },
            { ...signed, quote: { ...signed.quote, schedule: {} } },
            { ...signed, quote: { ...signed.quote, feeAmount: "200001" } },
            { ...signed, quote: { ...signed.quote, feeRecipient: trust.core } },
            { ...signed, quote: { ...signed.quote, token: trust.core } },
            { ...signed, quote: { ...signed.quote, deadline: "1900000001" } },
            { ...signed, quote: { ...signed.quote, maxGas: "0" } },
            { ...signed, quote: { ...signed.quote, requestHash: "0x" + "00".repeat(32) } },
        ];
        for (const variant of variants)
            expect(() =>
                verifyRouterBroadcasterQuote(
                    variant as SignedRouterBroadcasterQuote,
                    trust,
                    input,
                    1800000000n
                )
            ).toThrow();
        expect(() =>
            verifyRouterBroadcasterQuote(
                signed,
                { ...trust, quoteSigner: trust.core },
                input,
                1800000000n
            )
        ).toThrow();
        expect(() =>
            verifyRouterBroadcasterQuote(signed, { ...trust, chainId: 1n }, input, 1800000000n)
        ).toThrow();
        expect(() => verifyRouterBroadcasterQuote(signed, trust, input, 1900000001n)).toThrow();
    });
    it("rejects outer target, data, principal and authorization tampering before submission", async () => {
        const input = inputFor(envelopes[2]),
            signed = await signedFor(input);
        for (const mutated of [
            { ...input, outer: { ...input.outer, to: trust.core } },
            { ...input, outer: { ...input.outer, value: 1n } },
            { ...input, outer: { ...input.outer, data: (input.outer.data + "00") as Hex } },
            { ...input, authorizationList: [] },
            {
                ...input,
                authorizationList: input.authorizationList!.map((a) => ({
                    ...a,
                    nonce: a.nonce + 1n,
                })),
            },
        ]) {
            expect(() =>
                verifyRouterBroadcasterQuote(signed, trust, mutated, 1800000000n)
            ).toThrow();
        }
    });
    it("rejects mismatched JSON-RPC ids, untrusted estimates and rechecks quote before submit", async () => {
        const input = inputFor(envelopes[0]),
            signed = await signedFor(input);
        let calls = 0;
        const client = new PaymentRouterRelayClient({
            endpoint: "https://broadcaster.example",
            trust,
            transport: async (req) => {
                calls++;
                return { jsonrpc: "2.0", id: req.id + 1, result: signed };
            },
        });
        await expect(client.getQuote(input)).rejects.toThrow("JSON-RPC");
        await expect(
            client.submitTransaction({ ...input, outer: { ...input.outer, value: 1n } }, signed)
        ).rejects.toThrow();
        expect(calls).toBe(1);
        const badEstimate = new PaymentRouterRelayClient({
            endpoint: "https://broadcaster.example",
            trust,
            transport: async (req) => ({
                jsonrpc: "2.0",
                id: req.id,
                result: { feeRecipient: trust.core, feeAmount: "1", maxGas: "100" },
            }),
        });
        await expect(badEstimate.estimateQuote(input)).rejects.toThrow("estimate");
    });
});

it("caps a signed quote at Router and account authorization deadlines", async () => {
    const original = inputFor(envelopes[1]),
        router = new Interface(paymentRouterAbi),
        account = new Interface(paymentRouterAccountAbi);
    for (const layer of ["router", "account"]) {
        const args = account
            .decodeFunctionData("executeNativePayment", original.outer.data)
            .toArray(true);
        if (layer === "account") args[3] = 1800000000n;
        else {
            const inner = router.decodeFunctionData("payNative", args[0]).toArray(true);
            inner[2][6] = 1800000000n;
            args[0] = router.encodeFunctionData("payNative", inner);
        }
        const input = {
            ...original,
            outer: {
                ...original.outer,
                data: account.encodeFunctionData("executeNativePayment", args) as Hex,
            },
        };
        const signed = await signedFor(input);
        expect(() => verifyRouterBroadcasterQuote(signed, trust, input, 1700000000n)).toThrow(
            "bounds"
        );
    }
});
