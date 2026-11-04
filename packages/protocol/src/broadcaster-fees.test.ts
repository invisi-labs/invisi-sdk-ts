import { describe, expect, it } from "vitest";
import { createCreditPublicInputs } from "./credit-create";
import { cancelCreditPublicInputs, topUpCreditPublicInputs } from "./credit-lifecycle";
import vectors from "./protocol-vectors.json";
const revive = (v: any): any =>
    Array.isArray(v)
        ? v.map(revive)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, v]) => [k, revive(v)]))
          : typeof v === "string" && /^\d+$/.test(v)
            ? BigInt(v)
            : v;
const { context, fixtures } = revive(vectors);
const feeRecipient = "0x1111111111111111111111111111111111111111" as const;
describe("public Credit fee statements", () => {
    it("binds creation fee before authorization limbs", () => {
        const f = fixtures.create;
        const p = { ...f.params, feeRecipient, feeAmount: 1n };
        const words = createCreditPublicInputs(context, p, f.deliveries, f.funding);
        expect(words).toHaveLength(48);
        expect(BigInt(words[44]!)).toBe(BigInt(feeRecipient));
        expect(BigInt(words[45]!)).toBe(1n);
        expect(
            createCreditPublicInputs(
                context,
                { ...p, feeAmount: 2n },
                f.deliveries,
                f.funding
            ).slice(-2)
        ).not.toEqual(words.slice(-2));
    });
    it("rejects cancellation that leaves no owner refund", () => {
        const f = fixtures.cancel;
        expect(() =>
            cancelCreditPublicInputs(context, {
                ...f.params,
                feeRecipient,
                feeAmount: f.params.amount,
            })
        ).toThrow();
        const words = cancelCreditPublicInputs(context, {
            ...f.params,
            feeRecipient,
            feeAmount: 1n,
        });
        expect(words).toHaveLength(13);
        expect(BigInt(words[9]!)).toBe(BigInt(feeRecipient));
    });
    it("binds top-up fee before previous-credit public fields", () => {
        const f = fixtures.topUp;
        const words = topUpCreditPublicInputs(
            context,
            { ...f.params, creation: { ...f.params.creation, feeRecipient, feeAmount: 1n } },
            f.deliveries,
            f.funding
        );
        expect(words).toHaveLength(52);
        expect(BigInt(words[44]!)).toBe(BigInt(feeRecipient));
        expect(BigInt(words[45]!)).toBe(1n);
    });
});
