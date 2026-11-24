import { expect, it } from "vitest";
import { Wallet } from "@invisi-labs/primitives";
import { keccak256 } from "ethers";
import { BroadcasterClient, decodeBroadcasterIntent } from "./index";
import { setup } from "../transactions/execution/ExplicitTransaction-fixtures";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { testOutput } from "../../../../test-support/test-output";

it.each(["create-credit", "payout"] as const)(
    "reuses the %s estimate for the unchanged intent between fee iterations",
    async (kind) => {
        const h = await setup();
        const identity = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
        };
        const original =
            kind === "create-credit"
                ? await h.invisi.prepareCreateCredit({
                      ...identity,
                      spender: h.bob.getAddress(),
                      expiry: 2000003600n,
                  })
                : await h.invisi.prepareTransfer({
                      ...identity,
                      inputs: h.inputs,
                      outputs: [],
                      withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
                  });
        let estimates = 0;
        const service = quoteClient(h.context, () => (++estimates === 1 ? 1n : 2n));
        const estimateHashes: string[] = [];
        const quoteHashes: string[] = [];
        const client = new BroadcasterClient(service.configuration, async (request, options) => {
            const payload = (request.params as [{ data: string }])[0];
            if (request.method === "broadcaster_estimateQuote")
                estimateHashes.push(keccak256(payload.data));
            if (request.method === "broadcaster_getQuote")
                quoteHashes.push(keccak256(payload.data));
            return service.transport(request, options);
        });
        const quoted = await client.quote(original, {
            maxFeeAmount: 2n,
            maxAttempts: 2,
            ...(kind === "payout" ? { feeSource: "payout" as const } : {}),
        });
        expect(quoted.preview().feeAmount).toBe(2n);
        if (kind === "payout") expect(quoted.preview().withdrawalAmount).toBe(98n);
        expect(original.preview().feeAmount).toBe(0n);
        expect(estimateHashes).toHaveLength(3);
        expect(new Set(estimateHashes).size).toBe(3);
        expect(quoteHashes).toEqual([estimateHashes.at(-1)]);
    }
);

it.each([
    ["shield", "caller", "public-funding"],
    ["shield", "signature", "public-funding"],
    ["transfer", "caller", "public-funding"],
    ["transfer", "caller", "private-inputs"],
    ["transfer", "none", "private-inputs"],
] as const)(
    "prices the final fee and funding features before repricing %s with %s funding from %s",
    async (kind, authorization, feeSource) => {
        const h = await setup();
        const identity = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
        };
        const funding =
            authorization === "none"
                ? undefined
                : { payer: h.wallet.ownerAddress, amount: 30n, authorization };
        const outputs = [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })];
        const original =
            kind === "shield"
                ? await h.invisi.prepareShield({
                      ...identity,
                      funding: funding!,
                      outputs,
                  })
                : await h.invisi.prepareTransfer({
                      ...identity,
                      inputs: h.inputs,
                      ...(funding ? { funding } : {}),
                      outputs,
                  });
        if (authorization === "caller") {
            await expect(
                quoteClient(h.context).quote(original, { maxFeeAmount: 20n, feeSource })
            ).rejects.toMatchObject({ code: "NEEDS_REPREPARE" });
            return;
        }
        const before = await original.exportBroadcasterIntent();
        const beforePreview = original.preview();
        let required = 0n;
        const service = quoteClient(h.context, () => required);
        const estimates: { fee: bigint; deadline: bigint; recipient: string }[] = [];
        const quoteHashes: string[] = [];
        const estimateHashes: string[] = [];
        const client = new BroadcasterClient(service.configuration, async (request, options) => {
            const payload = (request.params as [{ data: string }])[0];
            if (request.method === "broadcaster_estimateQuote") {
                const { request: decoded } = decodeBroadcasterIntent(payload.data);
                // Match the Go broadcaster's discrete feeEnabled and fundingSignature features.
                const fee = decoded.params.feeAmount as bigint;
                const deadline = decoded.funding.deadline as bigint;
                required = 10n + (fee > 0n ? 2n : 0n) + (deadline > 0n ? 3n : 0n);
                estimates.push({ fee, deadline, recipient: decoded.params.feeRecipient });
                estimateHashes.push(keccak256(payload.data));
            }
            if (request.method === "broadcaster_getQuote")
                quoteHashes.push(keccak256(payload.data));
            return service.transport(request, options);
        });
        const finalFee = funding ? 15n : 12n;
        const quoted = await client.quote(original, { maxFeeAmount: finalFee, feeSource });
        expect(quoted.preview().feeAmount).toBe(finalFee);
        expect(quoted.preview().fundingAmount).toBe(
            feeSource === "public-funding" ? 45n : (funding?.amount ?? 0n)
        );
        expect(estimates).toHaveLength(kind === "shield" ? 1 : 2);
        expect(estimates[0]!.fee).toBe(1n);
        if (funding) expect(estimates[0]!.deadline).toBeGreaterThan(0n);
        else expect(estimates[0]!.deadline).toBe(0n);
        expect(estimates[0]!.recipient).toBe(service.configuration.feeRecipient);
        if (kind !== "shield") {
            expect(estimates[1]!.fee).toBe(finalFee);
            expect(quoteHashes).toEqual([estimateHashes.at(-1)]);
        } else {
            expect(quoteHashes).toHaveLength(1);
            expect(quoteHashes[0]).not.toBe(estimateHashes[0]);
        }
        expect(await original.exportBroadcasterIntent()).toEqual(before);
        expect(original.preview()).toEqual(beforePreview);
        await expect(
            client.quote(original, { maxFeeAmount: finalFee - 1n, feeSource })
        ).rejects.toThrow(/limit/);
    }
);

async function shieldQuoteFixture() {
    const h = await setup();
    const original = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        funding: {
            payer: h.wallet.ownerAddress,
            amount: 30n,
            authorization: "signature",
            sigNonce: 0n,
        },
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    return { ...h, original };
}
it("obtains an exact signed Shield quote without a redundant final estimate", async () => {
    const h = await shieldQuoteFixture();
    const base = quoteClient(h.context);
    const methods: string[] = [];
    const client = new BroadcasterClient(base.configuration, async (request, options) => {
        methods.push(request.method);
        return base.transport(request, options);
    });
    const quoted = await client.quote(h.original, { maxFeeAmount: 20n });
    expect(methods).toEqual(["broadcaster_estimateQuote", "broadcaster_getQuote"]);
    expect(quoted.preview().feeAmount).toBe(10n);
    expect(quoted.broadcasterQuote()!.quote.requestHash).toBeDefined();
});
it("refreshes price after a rejected Shield quote and binds the new fee within the attempt limit", async () => {
    const h = await shieldQuoteFixture();
    let required = 10n;
    const base = quoteClient(h.context, () => required);
    const methods: string[] = [];
    const client = new BroadcasterClient(base.configuration, async (request, options) => {
        methods.push(request.method);
        if (request.method === "broadcaster_getQuote") {
            required = 12n;
            const fee = decodeBroadcasterIntent((request.params as [{ data: string }])[0].data)
                .request.params.feeAmount;
            if (fee < required)
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32000, message: "Request rejected" },
                };
        }
        return base.transport(request, options);
    });
    const quoted = await client.quote(h.original, { maxFeeAmount: 12n, maxAttempts: 2 });
    expect(quoted.preview().feeAmount).toBe(12n);
    expect(methods).toEqual([
        "broadcaster_estimateQuote",
        "broadcaster_getQuote",
        "broadcaster_estimateQuote",
        "broadcaster_getQuote",
    ]);
    expect(h.original.preview().feeAmount).toBe(0n);
});
it.each(["unchanged", "over-limit", "transport", "last-attempt"])(
    "does not hide a %s Shield quote refusal",
    async (failure) => {
        const h = await shieldQuoteFixture();
        let required = 10n;
        const base = quoteClient(h.context, () => required);
        const methods: string[] = [];
        const client = new BroadcasterClient(base.configuration, async (request, options) => {
            methods.push(request.method);
            if (request.method === "broadcaster_getQuote") {
                if (failure === "transport") throw Error("quote connection failed");
                if (failure === "over-limit") required = 21n;
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32000, message: "Request rejected" },
                };
            }
            return base.transport(request, options);
        });
        await expect(
            client.quote(h.original, {
                maxFeeAmount: 20n,
                maxAttempts: failure === "last-attempt" ? 1 : 2,
            })
        ).rejects.toThrow(
            failure === "transport"
                ? /connection failed/
                : failure === "over-limit"
                  ? /limit/
                  : /Request rejected/
        );
        expect(methods.filter((method) => method === "broadcaster_getQuote")).toHaveLength(1);
        expect(methods.filter((method) => method === "broadcaster_estimateQuote")).toHaveLength(
            ["transport", "last-attempt"].includes(failure) ? 1 : 2
        );
    }
);
