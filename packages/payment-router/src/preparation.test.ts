import { expect, it } from "vitest";
import { Invisi, NoteOutput, Wallet } from "@invisi-labs/sdk";
import { fixture } from "../../../test-support/operation-fixture";
import { backend } from "../../sdk/src/transactions/execution/ExplicitTransaction-fixtures";
import { Interface } from "ethers";
import { coreInterface } from "./core-payment";
import {
    PaymentMode,
    buildRouterPaymentDraft,
    finalizeRouterPayment,
    paymentRouterAbi,
    estimateRouterPaymentGas,
} from "./index";
import { PaymentRouterClient, UniswapV3Adapter } from "./index";
import { A, chain, deployment, routerInterface } from "./testing";
it("composes actual detached SDK preparation and proof lifecycle with Router-funded outputs and fee", async () => {
    const h = await fixture(),
        rpc = chain();
    rpc.state.now = 2000000000;
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const client = new PaymentRouterClient({ deployment, provider: rpc.provider });
    const outputs = await Promise.all(
        [3n, 5n].map((amount, index) =>
            NoteOutput.create({
                chainId: 31337n,
                protocolAddress: A.core,
                tokenAddress: A.token,
                amount,
                recipient: {
                    type: "identity",
                    identity: ("0x" +
                        (100 + index).toString(16).padStart(64, "0")) as `0x${string}`,
                },
            })
        )
    );
    const prepared = await client.preparePayment({
        invisi,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: A.token,
        outputs,
        fee: { recipient: A.player, amount: 2n },
        deadline: 2000000500n,
    });
    expect(prepared.preview().inputs).toBe(0);
    expect(prepared.preview().funding).toMatchObject({
        payer: A.router,
        amount: 10n,
        authorization: "caller",
        sigNonce: 0n,
        deadline: 0n,
    });
    const canonical = new Interface(paymentRouterAbi);
    const originalCall = rpc.provider.call.bind(rpc.provider);
    rpc.provider.call = async (tx) =>
        tx.data?.toString().startsWith(canonical.getFunction("nonces")!.selector)
            ? canonical.encodeFunctionResult("nonces", [0n])
            : originalCall(tx);
    const draftOptions = {
        payment: prepared,
        payer: A.player,
        tokenIn: A.token,
        mode: PaymentMode.DirectToken,
        refundRecipient: A.player,
        deadline: 2000000100n,
        amountInMaximum: 10n,
    };
    const draft = await client.prepareRouterPaymentDraft(draftOptions);
    expect(draft.proof).toBe("0x");
    expect(
        coreInterface.decodeFunctionData(
            "transact",
            (await prepared.exportBroadcasterIntent()).data
        )[0]
    ).toBe("0x");
    expect(() => client.buildRouterTransaction(draft)).toThrow("proof");
    expect(buildRouterPaymentDraft(draft).value).toBe(0n);
    const baseline = prepared.estimateGas();
    expect(baseline.available).toBe(true);
    if (baseline.available)
        expect(estimateRouterPaymentGas(draft, baseline.gasUnits)).toMatchObject({
            available: true,
            source: "model",
        });
    await expect(
        client.prepareRouterPayment({
            ...draftOptions,
            payment: {
                to: A.core,
                value: 0n,
                data: (await prepared.exportBroadcasterIntent()).data,
            },
        })
    ).rejects.toThrow("proof");
    // The cryptographic backend is the explicit test boundary; SDK statement/proof checks are real.
    const ready = await prepared.prove(backend());
    const actual = finalizeRouterPayment(draft, await ready.exportTransaction());
    expect(actual.proof).not.toBe("0x");
    expect(actual.intent.coreRequestHash).not.toBe(draft.intent.coreRequestHash);
    expect(() => client.buildRouterTransaction(actual)).not.toThrow();
    await expect(
        client.prepareRouterPaymentDraft({ ...draftOptions, payment: prepared })
    ).rejects.toThrow(); // stale prepared handle

    const quote = await client.quote(
        new UniswapV3Adapter({
            provider: rpc.provider,
            quoterAddress: A.quoter,
            routes: [{ tokens: [A.weth, A.token], fees: [3000] }],
        }),
        { tokenOut: A.token, amountOut: 10n, maxInput: 100n, deadline: 2000000100n }
    );
    const call = await client.buildPaymentTransaction({
        payment: ready,
        quote,
        refundRecipient: A.player,
    });
    const request = routerInterface.parseTransaction(call)!.args[1];
    expect(request.funding.payer).toBe(A.router);
    expect(request.funding.amount).toBe(10n);
    expect(request.params.feeAmount).toBe(2n);
    expect(request.params.noteCommitments).toEqual(outputs.map((output) => output.commitment));
    expect(request.params.sources.length).toBe(0);
    await expect(
        client.preparePayment({
            invisi,
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: A.token,
            outputs: outputs.slice(0, 1),
        })
    ).rejects.toThrow(/at least two/);
});

it("pins the requested output order and fee before asynchronous deployment checks", async () => {
    const h = await fixture(),
        rpc = chain();
    rpc.state.now = 2000000000;
    const client = new PaymentRouterClient({ deployment, provider: rpc.provider });
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const outputs = await Promise.all(
        [3n, 5n].map((amount, index) =>
            NoteOutput.create({
                chainId: 31337n,
                protocolAddress: A.core,
                tokenAddress: A.token,
                amount,
                recipient: {
                    type: "identity",
                    identity: ("0x" +
                        (110 + index).toString(16).padStart(64, "0")) as `0x${string}`,
                },
            })
        )
    );
    const expected = outputs.map((output) => output.commitment);
    const fee = { recipient: A.player, amount: 2n };
    const pending = client.preparePayment({
        invisi,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: A.token,
        outputs,
        fee,
        deadline: 2000000500n,
    });
    fee.amount = 9n;
    outputs.reverse();
    const prepared = await pending;
    expect(prepared.preview().funding.amount).toBe(10n);
    expect(prepared.preview().outputs.map((output) => output.commitment)).toEqual(expected);
});
