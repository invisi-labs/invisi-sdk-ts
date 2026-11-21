import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Interface, Wallet, ZeroHash } from "ethers";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { paymentRouterAbi, paymentRouterAccountAbi } from "./canonical-abi";
import { coreInterface } from "./core-payment";
import {
    hashCoreRequest,
    hashRouterIntent,
    relayDraftEnvelope,
    relayEnvelope,
    unsignedDelegation,
} from "./canonical";
import {
    PaymentRouterRelayClient,
    routerBroadcasterQuoteDomain,
    routerBroadcasterQuoteTypes,
    type RouterRelayInput,
} from "./relay-client";
const vectors = JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/envelope-vectors.json", import.meta.url),
        "utf8"
    )
);
const fixture = JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/intent-vectors.json", import.meta.url),
        "utf8"
    )
);
const router = new Interface(paymentRouterAbi),
    account = new Interface(paymentRouterAccountAbi);
function variant(vector: any, proof: Hex, change?: (args: any[]) => void): RouterRelayInput {
    let data = vector.envelope.data;
    let wrapper: any[] | undefined;
    if (data.slice(0, 10) === account.getFunction("executeNativePayment")!.selector) {
        wrapper = account.decodeFunctionData("executeNativePayment", data).toArray(true);
        data = wrapper[0];
    }
    const parsed = router.parseTransaction({ data })!,
        args = parsed.args.toArray(true);
    args[0] = proof;
    change?.(args);
    args[2][7] = hashCoreRequest(
        proof,
        coreInterface.decodeFunctionData(
            "transact",
            coreInterface.encodeFunctionData("transact", [proof, args[1]])
        )[1]
    );
    if (parsed.name === "payTokenFor") args[5] = proof === "0x" ? "0x" : "0x1234";
    data = router.encodeFunctionData(parsed.name, args);
    if (wrapper) {
        wrapper[0] = data;
        wrapper[1] = args[2][2];
        wrapper[5] = proof === "0x" ? "0x" : "0x1234";
        data = account.encodeFunctionData("executeNativePayment", wrapper);
    }
    return {
        coreCalldata: coreInterface.encodeFunctionData("transact", [proof, args[1]]) as Hex,
        outer: { to: vector.envelope.to, value: 0n, data },
        ...(vector.envelope.authorizationList
            ? {
                  authorizationList: vector.envelope.authorizationList.map((a: any) =>
                      unsignedDelegation({
                          address: a.address,
                          chainId: BigInt(a.chainId),
                          nonce: BigInt(a.nonce),
                      })
                  ),
              }
            : {}),
    };
}
const hash = (input: RouterRelayInput) =>
    hashRouterIntent(31337n, fixture.addresses.core, input.outer, input.authorizationList);
describe("quote before proving", () => {
    for (const vector of vectors)
        it("normalizes proof and wallet signatures: " + vector.name, () => {
            const draft = variant(vector, "0x"),
                final = variant(vector, "0xabcdef");
            expect(hash(draft)).toBe(hash(final));
            expect(() =>
                relayDraftEnvelope(draft.coreCalldata, draft.outer, draft.authorizationList)
            ).not.toThrow();
            expect(() =>
                relayEnvelope(draft.coreCalldata, draft.outer, draft.authorizationList)
            ).toThrow();
            for (const change of [
                (a: any[]) => a[1][0][8]++,
                (a: any[]) => a[2][2]++,
                (a: any[]) => a[2][5]++,
                (a: any[]) => a[2][6]--,
            ])
                expect(hash(variant(vector, "0x", change))).not.toBe(hash(draft));
            expect(() =>
                hashRouterIntent(
                    31337n,
                    fixture.addresses.core,
                    { ...draft.outer, data: (draft.outer.data + "00") as Hex },
                    draft.authorizationList
                )
            ).toThrow();
        });
    it("verifies the same signed quote for unsigned draft and final proof on the RPC wire", async () => {
        const draft = variant(vectors[0], "0x"),
            final = variant(vectors[0], "0xabcdef");
        const wallet = new Wallet("0x" + "01".padStart(64, "0"));
        const trust = {
            chainId: 31337n,
            core: fixture.addresses.core,
            quoteSigner: wallet.address as Hex,
            feeRecipient: fixture.addresses.relayer,
        };
        const quote = {
            token: fixture.addresses.token,
            feeRecipient: trust.feeRecipient,
            feeAmount: "200000",
            deadline: "1900000000",
            maxGas: "1000000",
            requestHash: hash(draft),
            execution: "direct" as const,
        };
        const signed = {
            quote,
            requestHashFormat: "payment-router-intent-v1" as const,
            signature: (await wallet.signTypedData(
                routerBroadcasterQuoteDomain(trust),
                routerBroadcasterQuoteTypes,
                quote
            )) as Hex,
        };
        const calls: any[] = [];
        const client = new PaymentRouterRelayClient({
            endpoint: "https://example.test",
            trust,
            transport: async (request) => {
                calls.push(request);
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result:
                        request.method === "broadcaster_getQuote"
                            ? signed
                            : { id: "same-intent", state: "pending" },
                };
            },
        });
        expect(await client.getQuote(draft)).toEqual(signed);
        await client.submitTransaction(final, signed);
        expect(calls[0].params[0].data).toBe(draft.coreCalldata);
        expect(calls[1].params[0].data).toBe(final.coreCalldata);
        await expect(client.submitTransaction(draft, signed)).rejects.toThrow();
    });
});

it("matches Go semantic intent hashes for draft and final canonical ABI bytes", () => {
    const vectors = JSON.parse(
        readFileSync(
            new URL(
                "../../../test-support/payment-router/preprove-intent-vectors.json",
                import.meta.url
            ),
            "utf8"
        )
    );
    for (const row of vectors)
        for (const envelope of [row.draftEnvelope, row.finalEnvelope]) {
            const auths = envelope.authorizationList?.map((a: any) => ({
                address: a.address,
                chainId: BigInt(a.chainId),
                nonce: BigInt(a.nonce),
                signature: { yParity: Number(BigInt(a.yParity)) as 0 | 1, r: a.r, s: a.s },
            }));
            expect(
                hashRouterIntent(
                    BigInt(row.chainId),
                    row.core,
                    { ...envelope, value: BigInt(envelope.value) },
                    auths
                )
            ).toBe(row.intentHash);
        }
});
