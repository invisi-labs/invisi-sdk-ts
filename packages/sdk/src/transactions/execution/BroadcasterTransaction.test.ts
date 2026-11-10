import { Wallet } from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Wallet as EvmWallet, Interface, getAddress } from "ethers";
import { expect, it, vi } from "vitest";
import { testOutput } from "../../../../../test-support/test-output";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

it("binds an immediate public fee and withdrawal while conserving private change", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        withdrawal: { to: h.wallet.ownerAddress, amount: 20n },
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    expect(prepared.preview().outputs.map((output) => output.amount)).toEqual([30n, 40n]);
    expect(prepared.preview().feeAmount).toBe(10n);
    expect(prepared.preview().withdrawalAmount).toBe(20n);
    const ready = await (await externallyAuthorize(prepared)).prove();
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
    expect(decoded.args[1].params.feeAmount).toBe(10n);
    expect(BigInt(decoded.args[1].params.feeRecipient)).toBe(BigInt(h.bob.ownerAddress));
});

it("never treats a fee-bearing owner withdrawal as an unsigned sweep", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 90n },
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    expect(prepared.preview().permissions.walletAuthorization).toBe(true);
    await expect(prepared.prove()).rejects.toThrow();
});

it("includes the fee in insufficient-funds selection", async () => {
    const h = await setup();
    await expect(
        h.invisi.prepareTransfer({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [],
            withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
            fee: { recipient: h.bob.ownerAddress, amount: 1n },
        })
    ).rejects.toThrow(/insufficient/i);
});

it("exports a non-sendable frozen public intent before authorization for a firm quote", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    const intent = await prepared.exportBroadcasterIntent();
    expect(intent.sendable).toBe(false);
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: intent.data })!;
    expect(decoded.args[0]).toBe("0x");
    expect(decoded.args[1].params.feeAmount).toBe(10n);
    expect(intent).not.toHaveProperty("witness");
    const ready = await (await externallyAuthorize(prepared)).prove();
    const { broadcasterRequestHash } = await import("../../broadcaster/index");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        broadcasterRequestHash(intent.data)
    );
});

it("carries a pre-authorization firm quote through local proof to public-only paid submission", async () => {
    const h = await setup();
    const {
        BroadcasterClient,
        broadcasterRequestHash,
        broadcasterQuoteDomain,
        broadcasterQuoteTypes,
    } = await import("../../broadcaster/index");
    const operator = new EvmWallet(`0x${"03".repeat(32)}`);
    const trust = {
        chainId: h.context.chainId,
        protocol: h.context.protocolAddress,
        signer: operator.address,
    };
    const transport = vi.fn(
        async (request: { jsonrpc: "2.0"; id: number; method: string; params: unknown }) => {
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (
                request.method === "broadcaster_getQuote" &&
                (request.params as any[])[0].mode === "estimate"
            )
                return result({
                    mode: "estimate",
                    feeRecipient: operator.address,
                    feeAmount: "10",
                    maxGas: "2000000",
                });
            const payload = (request.params as unknown[])[0] as {
                data: string;
                quote?: { requestHash: string };
                idempotencyKey?: string;
            };
            if (request.method === "broadcaster_getQuote") {
                const quote = {
                    token: h.context.tokenAddress,
                    feeRecipient: operator.address,
                    feeAmount: "10",
                    deadline: String(BigInt(Math.floor(Date.now() / 1000)) + 60n),
                    maxGas: "2000000",
                    requestHash: broadcasterRequestHash(payload.data),
                };
                return result({
                    mode: "firm",
                    quote,
                    signature: await operator.signTypedData(
                        broadcasterQuoteDomain(trust),
                        broadcasterQuoteTypes,
                        quote
                    ),
                });
            }
            expect(request.method).toBe("broadcaster_submitTransaction");
            expect(broadcasterRequestHash(payload.data)).toBe(payload.quote!.requestHash);
            expect(Object.keys(payload).sort()).toEqual([
                "data",
                "idempotencyKey",
                "quote",
                "signature",
            ]);
            return result({
                id: payload.idempotencyKey!,
                state: "submitted",
                transactionHash: `0x${"45".repeat(32)}`,
            });
        }
    );
    const client = new BroadcasterClient(
        {
            endpoint: "https://broadcaster.test",
            quoteSigner: trust.signer,
            feeRecipient: trust.signer,
        },
        transport
    );
    const original = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const prepared = await original.withBroadcaster(client, { maxFeeAmount: 10n });
    expect(original.preview().feeAmount).toBe(0n);
    const signed = prepared.broadcasterQuote()!;
    expect(h.prover.prove).not.toHaveBeenCalled();
    const ready = await (await externallyAuthorize(prepared)).prove();
    const status = await client.submit(
        (await ready.exportTransaction()).data,
        signed,
        "paid-request-1"
    );
    expect(status.state).toBe("submitted");
    expect(ready.preview().outputs.map((output) => output.amount)).toEqual([30n, 60n]);
});

it("adds a Shield broadcaster fee to public funding without shrinking its business outputs", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const original = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(original.preview().fundingAmount).toBe(30n);
    expect(quoted.preview().fundingAmount).toBe(40n);
    expect(original.preview().funding).toMatchObject({
        payer: getAddress(h.wallet.ownerAddress),
        amount: 30n,
        authorization: "caller",
    });
    expect(quoted.preview().funding).toMatchObject({
        payer: getAddress(h.wallet.ownerAddress),
        amount: 40n,
        authorization: "signature",
    });
    expect(quoted.preview().funding).not.toHaveProperty("signature");

    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n]);
    expect(quoted.preview().permissions.fundingAuthorization).toBe(true);
    const request = await quoted.exportFundingAuthorization();
    const signer = new EvmWallet(`0x${"01".repeat(32)}`);
    const ready = await quoted.withFundingSignature(
        await signer.signTypedData(request.domain, request.types, request.message)
    );
    const { broadcasterRequestHash } = await import("../../broadcaster/index");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        ready.broadcasterQuote()!.quote.requestHash
    );
    expect(h.prover.prove).not.toHaveBeenCalled();
    await expect(
        original.withBroadcaster(quoteClient(h.context), {
            maxFeeAmount: 10n,
            feeSource: "private-inputs",
        })
    ).rejects.toThrow(/source/);
});

it("rejects excessive or unstable broadcaster fees before signing and preserves the original plan", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    await expect(
        prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 9n })
    ).rejects.toThrow(/limit/);
    let amount = 0n;
    await expect(
        prepared.withBroadcaster(
            quoteClient(h.context, () => ++amount),
            { maxFeeAmount: 10n, maxAttempts: 2 }
        )
    ).rejects.toThrow(/stabilize/);
    expect(prepared.preview().feeAmount).toBe(0n);
    expect(prepared.broadcasterQuote()).toBeUndefined();
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    await expect(
        (await externallyAuthorize(quoted)).prove({ execution: "aggregate" })
    ).rejects.toThrow(/direct/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect((await externallyAuthorize(prepared)).status).toBe("authorized");
});

it("requests an app-owned permit once after the gross funding amount stabilizes", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const permit = {
        deadline: 2000003600n,
        v: 27,
        r: `0x${"11".repeat(32)}` as `0x${string}`,
        s: `0x${"22".repeat(32)}` as `0x${string}`,
    };
    const original = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller", permit },
    });
    await expect(
        original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n })
    ).rejects.toThrow(/existing permit/);
    const fundingPermit = vi.fn(async (request: { amount: bigint }) => {
        expect(request.amount).toBe(40n);
        return { ...permit, deadline: 2000007200n };
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), {
        maxFeeAmount: 10n,
        fundingPermit,
    });
    expect(fundingPermit).toHaveBeenCalledOnce();
    const { decodeBroadcasterIntent } = await import("../../broadcaster/index");
    expect(
        decodeBroadcasterIntent((await quoted.exportBroadcasterIntent()).data).request.funding
            .permit.deadline
    ).toBe(2000007200n);
});

it("re-quotes from the original public funding intent without accumulating fees", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const original = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    const replaced = await quoted.withBroadcaster(
        quoteClient(h.context, () => 5n),
        { maxFeeAmount: 10n }
    );
    expect(original.preview().fundingAmount).toBe(30n);
    expect(quoted.preview().fundingAmount).toBe(40n);
    expect(replaced.preview().fundingAmount).toBe(35n);
    expect(replaced.preview().outputs.map((o) => o.amount)).toEqual([30n]);
});

it("broadcasts a zero-input funded transfer while preserving its business payment and change", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const original = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: [],
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(quoted.preview().fundingAmount).toBe(110n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n, 70n]);
    expect(quoted.preview().permissions.walletAuthorization).toBe(false);
    await expect(quoted.exportWalletAuthorization()).rejects.toThrow(/does not require/);
    const proved = await quoted.prove();
    const request = await proved.exportFundingAuthorization();
    const signer = new EvmWallet(`0x${"01".repeat(32)}`);
    const ready = await proved.withFundingSignature(
        await signer.signTypedData(request.domain, request.types, request.message)
    );
    const { broadcasterRequestHash } = await import("../../broadcaster/index");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        ready.broadcasterQuote()!.quote.requestHash
    );
});

it("uses existing private change before increasing mixed public funding", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 130n })],
        funding: { payer: h.wallet.ownerAddress, amount: 50n, authorization: "signature" },
    });
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(quoted.preview().fundingAmount).toBe(50n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([130n, 10n]);
    expect(prepared.preview().outputs.map((o) => o.amount)).toEqual([130n, 20n]);
    const explicit = await prepared.withBroadcaster(quoteClient(h.context), {
        maxFeeAmount: 10n,
        feeSource: "public-funding",
    });
    expect(explicit.preview().fundingAmount).toBe(60n);
});

it("refreshes caller-only zero nonce and deadline when attaching a broadcaster", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    h.reader.getFundingNonce = async () => 7n;
    const prepared = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: {
            payer: h.wallet.ownerAddress,
            amount: 30n,
            authorization: "caller",
            sigNonce: 0n,
            deadline: 0n,
        },
    });
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    const request = await quoted.exportFundingAuthorization();
    expect(BigInt(request.message.sigNonce as string)).toBe(7n);
    expect(BigInt(request.message.deadline as bigint)).toBeGreaterThan(0n);
});

it("stops fee iteration when rebuilt intent pays at least its recalculated fee", async () => {
    const h = await setup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    let calls = 0;
    const client = quoteClient(h.context, () => [10n, 20n, 10n][calls++] ?? 10n);
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 80n })],
    });
    const quoted = await prepared.withBroadcaster(client, { maxFeeAmount: 20n });
    expect(quoted.preview().feeAmount).toBe(20n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([80n]);
    expect(prepared.preview().feeAmount).toBe(0n);
    expect(calls).toBe(3);
    expect(h.prover.prove).not.toHaveBeenCalled();
});
