import { it, expect } from "vitest";
import { Interface } from "ethers";
import * as api from "../index";
import { invisiCoreAbi } from "../contracts";
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
it.each([1, 15, 57, 113])(
    "matches independently generated Note words and authorization for %i outputs",
    (n) => {
        const f = fixtures["transact" + n];
        expect(api.transactPublicInputs(context, f.params, f.deliveries)).toEqual(f.publicInputs);
        expect(api.transactUserPublicInputs(context, f.params, f.deliveries)).toEqual(
            f.userPublicInputs
        );
        expect(api.encodeTransactTypedData(context, f.params, f.deliveries)).toEqual(f.typedData);
    }
);
it("preserves tagged direct and aggregate funding authorization boundaries", () => {
    const f = fixtures.transact1;
    expect(api.transactFundingRequestHash("0x1234", f.params, f.deliveries)).toBe(
        f.fundingRequestHash
    );
    expect(
        api.aggregateMemberRequestHash(context, {
            params: f.params,
            deliveries: f.deliveries,
            funding: api.EMPTY_FUNDING,
        })
    ).toBe(f.memberRequestHash);
    expect(api.transactFundingRequestHash("0x1235", f.params, f.deliveries)).not.toBe(
        f.fundingRequestHash
    );
});
it("encodes canonical direct and cross-tree Note requests", () => {
    for (const key of ["transact1", "single", "crossTwo"]) {
        const f = fixtures[key];
        expect(
            api.buildTransactCalldata({
                context,
                proof: "0x1234",
                params: f.params,
                deliveries: f.deliveries,
            }).data
        ).toBe(f.calldata);
    }
});
it("encodes current public shield funding without a ZK proof", async () => {
    const f = fixtures.shield;
    expect(api.shieldFundingRequestHash(f.params, f.outputs, f.deliveries)).toBe(f.requestHash);
    expect(
        (
            await api.buildShieldCalldata({
                context,
                params: f.params,
                outputs: f.outputs,
                deliveries: f.deliveries,
                funding: f.funding,
            })
        ).data
    ).toBe(f.calldata);
});
it("rejects duplicate inputs, unsorted trees and noncanonical source counts", () => {
    const f = fixtures.crossTwo;
    for (const p of [
        { ...f.params, sources: [] },
        { ...f.params, sources: [...f.params.sources].reverse() },
        { ...f.params, nullifiers: [f.params.nullifiers[0], f.params.nullifiers[0]] },
    ])
        expect(() => api.transactPublicInputs(context, p, f.deliveries)).toThrow();
});
it("rejects zero-input single-output transact and preserves explicit shield alternative", () => {
    const f = fixtures.transact1;
    expect(() =>
        api.transactPublicInputs(
            context,
            { ...f.params, sources: [], nullifiers: [] },
            f.deliveries,
            { payer: context.tokenAddress, amount: 1n }
        )
    ).toThrow();
});
it("encodes atomic Note aggregates for current dedicated and mixed route counts", () => {
    const f = fixtures.transact1;
    for (const count of [1, 2, 3, 4, 5]) {
        const requests = Array.from({ length: count }, () => ({
            params: f.params,
            deliveries: f.deliveries,
            funding: api.EMPTY_FUNDING,
        }));
        const call = api.buildTransactAggregateCalldata({ context, proof: "0x1234", requests });
        expect(
            new Interface(invisiCoreAbi).parseTransaction({ data: call.data })!.args[1]
        ).toHaveLength(count);
        expect(api.aggregatePublicInputs(context, requests)).toHaveLength(
            count * (1 + f.publicInputs.length)
        );
    }
});
it("keeps aggregate allowance requirements separate for each token and payer", () => {
    const f = fixtures.transact1,
        payer = "0x3333333333333333333333333333333333333333",
        other = "0x4444444444444444444444444444444444444444";
    const call = api.buildTransactAggregateCalldata({
        context,
        proof: "0x1234",
        caller: payer,
        requests: [
            {
                params: f.params,
                deliveries: f.deliveries,
                funding: { ...api.EMPTY_FUNDING, payer, amount: 7n },
            },
            {
                params: f.params,
                deliveries: f.deliveries,
                funding: { ...api.EMPTY_FUNDING, payer, amount: 2n },
            },
            {
                params: { ...f.params, token: other },
                deliveries: f.deliveries,
                funding: { ...api.EMPTY_FUNDING, payer, amount: 9n },
            },
        ],
    });
    expect(call.approvalRequirements).toEqual([
        { token: f.params.token, payer, amount: 9n },
        { token: other, payer, amount: 9n },
    ]);
    expect(call).not.toHaveProperty("approveAmount");
});
