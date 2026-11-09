import { it, expect } from "vitest";
import * as api from "../index";
import raw from "../protocol-vectors.json";
const revive = (v: any): any =>
    Array.isArray(v)
        ? v.map(revive)
        : v && typeof v === "object"
          ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, k === "version" ? x : revive(x)])
            )
          : typeof v === "string" && /^\d+$/.test(v)
            ? BigInt(v)
            : v;
const { context, fixtures } = revive(raw);
it("matches independently encoded positive owner fees and gross draw deductions", () => {
    for (const [key, encode, build] of [
        ["createFee", api.createCreditPublicInputs, api.buildCreateCreditCalldata],
        ["updateFee", api.updateCreditPublicInputs, api.buildUpdateCreditCalldata],
        ["drawFee", api.creditDrawPublicInputs, api.buildCreditDrawCalldata],
    ] as const) {
        const f = fixtures[key];
        expect(encode(context, f.params, f.deliveries)).toEqual(f.publicInputs);
        const call = build({
            context,
            params: f.params,
            deliveries: f.deliveries,
            proof: "0x1234",
        });
        expect(call.data).toBe(f.calldata);
        expect(call.approveAmount).toBe(key === "drawFee" ? 0n : 3n);
        const changed = { ...f.params, feeAmount: 2n };
        expect(encode(context, changed, f.deliveries).slice(-2)).not.toEqual(
            f.publicInputs.slice(-2)
        );
    }
});
it("binds public revocation feeRecipient and feeAmount in EIP712 and eight-argument calldata", () => {
    const f = fixtures.revokeFee;
    expect(api.encodeRevokeCreditTypedData(context, f.params)).toEqual(f.typedData);
    const call = api.buildRevokeCreditCalldata({ context, params: f.params, signature: "0x1234" });
    expect(call.data).toBe(f.calldata);
    expect(call.approveAmount).toBe(3n);
});
it("rejects inconsistent fee context, fee overflow and a draw fee that consumes its whole Note", () => {
    const f = fixtures.create;
    for (const change of [
        { feeRecipient: "0x0000000000000000000000000000000000000000", feeAmount: 1n },
        { feeRecipient: fixtures.createFee.params.feeRecipient, feeAmount: 0n },
        { feeRecipient: fixtures.createFee.params.feeRecipient, feeAmount: 1n << 128n },
    ])
        expect(() =>
            api.createCreditPublicInputs(context, { ...f.params, ...change }, f.deliveries)
        ).toThrow();
    const d = fixtures.drawFee;
    expect(() =>
        api.creditDrawPublicInputs(
            context,
            { ...d.params, feeAmount: d.params.totalAmount },
            d.deliveries
        )
    ).toThrow(/positive/);
    expect(() =>
        api.createCreditPublicInputs(context, { ...f.params, funding: {} }, f.deliveries)
    ).toThrow(/unsupported/);
});
