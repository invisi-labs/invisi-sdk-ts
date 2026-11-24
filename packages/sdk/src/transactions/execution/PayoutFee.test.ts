import { expect, it } from "vitest";
import { Wallet } from "@invisi-labs/primitives";
import { setup } from "./ExplicitTransaction-fixtures";
import { quoteClient } from "../../../../../test-support/broadcaster-fixture";
it("deducts payout fees and reprices immutably with owner authorization", async () => {
    const h = await setup();
    const original = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
    });
    const quoted = await quoteClient(h.context).quote(original, {
        maxFeeAmount: 20n,
        feeSource: "payout",
    });
    expect(quoted.preview().withdrawalAmount).toBe(90n);
    expect(quoted.preview().outputs).toEqual([]);
    expect(quoted.preview().permissions.walletAuthorization).toBe(true);
    const repriced = await quoteClient(h.context, () => 5n).quote(quoted, {
        maxFeeAmount: 20n,
        feeSource: "payout",
    });
    expect(repriced.preview().withdrawalAmount).toBe(95n);
    expect(quoted.preview().withdrawalAmount).toBe(90n);
    expect(original.preview().withdrawalAmount).toBe(100n);
    await expect(
        quoteClient(h.context, () => 100n).quote(original, {
            maxFeeAmount: 100n,
            feeSource: "payout",
        })
    ).rejects.toThrow(/positive/);
    await expect(
        quoteClient(h.context).quote(original, { maxFeeAmount: 5n, feeSource: "payout" })
    ).rejects.toThrow(/limit/);
});
it("rejects payout fees when a withdrawal retains private change or public funding", async () => {
    const h = await setup(),
        base = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [],
        };
    const change = await h.invisi.prepareTransfer({
        ...base,
        withdrawal: { to: h.wallet.ownerAddress, amount: 90n },
    });
    await expect(
        quoteClient(h.context).quote(change, { maxFeeAmount: 10n, feeSource: "payout" })
    ).rejects.toThrow(/pure/);
    const funded = await h.invisi.prepareTransfer({
        ...base,
        withdrawal: { to: h.wallet.ownerAddress, amount: 110n },
        funding: { payer: h.wallet.ownerAddress, amount: 10n, authorization: "signature" },
    });
    await expect(
        quoteClient(h.context).quote(funded, { maxFeeAmount: 10n, feeSource: "payout" })
    ).rejects.toThrow(/pure/);
});
