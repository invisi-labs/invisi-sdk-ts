import { Interface } from "ethers";
import fixture from "../../../prover/src/testing/initial-payment-fixture.json";
import { invisiCoreAbi, type CreditCreationParams, type Delivery } from "../contracts";
import { expect, it } from "vitest";
import { buildCreateCreditCalldata, createCreditPublicInputs } from "./credit-create";

it("rejects unflagged initial-payment fields", () => {
    const base = {
        chainId: 1n,
        protocolAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
    } as const;
    const params = {
        token: base.tokenAddress,
        owner: base.protocolAddress,
        grantId: 1n,
        creditCommitment: `0x${"01".repeat(32)}` as const,
        deadline: 100n,
        totalAmount: 1n,
    } as unknown as CreditCreationParams;
    expect(() => createCreditPublicInputs(base, params, [])).toThrow(/initial payment/i);
    expect(() =>
        buildCreateCreditCalldata({ context: base, params, deliveries: [], proof: "0xaa" })
    ).toThrow(/initial payment/i);
});

it("matches the Core proof statement and uses the canonical tuple for pure creation", () => {
    const { context: c, params: v } = fixture;
    const context = {
        ...c,
        chainId: BigInt(c.chainId),
        timestamp: BigInt(c.timestamp),
    } as Parameters<typeof createCreditPublicInputs>[0];
    const params = {
        ...v,
        grantId: BigInt(v.grantId),
        deadline: BigInt(v.deadline),
        feeAmount: BigInt(v.feeAmount),
        totalAmount: BigInt(v.totalAmount),
    } as CreditCreationParams;
    const deliveries = fixture.deliveries as Delivery[];
    expect(createCreditPublicInputs(context, params, deliveries)).toEqual(fixture.publicInputs);
    const combined = buildCreateCreditCalldata({ context, params, deliveries, proof: "0xaa" });
    expect(combined.approveAmount).toBe(7n);
    expect(combined.approvalRequirements).toEqual([
        { token: params.token, payer: params.owner, amount: 7n },
    ]);
    const iface = new Interface(invisiCoreAbi);
    expect(iface.parseTransaction({ data: combined.data })!.args[1].hasInitialPayment).toBe(true);
    const { hasInitialPayment, totalAmount, noteCommitment, ...legacy } = params;
    const pure = { context, deliveries: deliveries.slice(0, 2), proof: "0xaa" as const };
    const current = buildCreateCreditCalldata({
        ...pure,
        params: { ...legacy, hasInitialPayment: false },
    });
    expect(iface.parseTransaction({ data: current.data })!.args[1].hasInitialPayment).toBe(false);
    expect(buildCreateCreditCalldata({ ...pure, params: legacy }).data).toBe(current.data);
    expect(() =>
        buildCreateCreditCalldata({
            ...pure,
            params: { ...legacy, creationAbi: "legacy" } as unknown as CreditCreationParams,
        })
    ).toThrow(/unsupported/);
    expect(
        createCreditPublicInputs(context, { ...legacy, hasInitialPayment: false }, pure.deliveries)
    ).toEqual(createCreditPublicInputs(context, legacy, pure.deliveries));
});
