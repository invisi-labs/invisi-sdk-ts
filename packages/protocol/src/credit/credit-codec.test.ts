import { it, expect, describe } from "vitest";
import { Interface, TypedDataEncoder } from "ethers";
import * as api from "../index";
import { invisiProtocolAbi } from "../contracts";
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
const { context, fixtures } = revive(raw),
    iface = new Interface(invisiProtocolAbi);
describe("deferred Credit independent protocol vectors", () => {
    it("binds create and update exactly without any cash funding", () => {
        for (const [key, words, typed, build] of [
            [
                "create",
                api.createCreditPublicInputs,
                api.encodeCreateCreditTypedData,
                api.buildCreateCreditCalldata,
            ],
            [
                "update",
                api.updateCreditPublicInputs,
                api.encodeUpdateCreditTypedData,
                api.buildUpdateCreditCalldata,
            ],
        ] as const) {
            const f = fixtures[key];
            expect(words(context, f.params, f.deliveries)).toEqual(f.publicInputs);
            expect(typed(context, f.params, f.deliveries)).toEqual(f.typedData);
            expect(
                build({ context, params: f.params, deliveries: f.deliveries, proof: "0x1234" }).data
            ).toBe(f.calldata);
            expect(f.deliveries).toHaveLength(2);
        }
    });
    it.each([1, 2, 6, 11, 21, 31, 41, 51, 61, 71, 80])(
        "matches current draw capacity and protocol public words for N=%i",
        (n) => {
            const f = fixtures["draw" + n];
            expect(api.creditDrawPublicInputs(context, f.params, f.deliveries)).toEqual(
                f.publicInputs
            );
            expect(f.publicInputs).toHaveLength(17 + 10 * api.selectCreditDrawCircuit(n).capacity);
            expect(api.encodeCreditDrawTypedData(context, f.params, f.deliveries)).toEqual(
                f.typedData
            );
            expect(f.params.stateCommitments).toHaveLength(n);
            expect(f.deliveries).toHaveLength(2 * n + 1);
        }
    );
    it("encodes one ordinary Note with every successor state", () => {
        const f = fixtures.draw1;
        expect(
            api.buildCreditDrawCalldata({
                context,
                params: f.params,
                deliveries: f.deliveries,
                proof: "0x1234",
            }).data
        ).toBe(f.calldata);
        expect(iface.decodeFunctionData("creditDraw", f.calldata)[1].noteCommitment).toBe(
            f.params.noteCommitment
        );
    });
    it("enforces grouping and distinct grant namespace ordering", () => {
        const f = fixtures.draw2;
        for (const p of [
            { ...f.params, totalAmount: 1n },
            { ...f.params, grantRefs: [f.params.grantRefs[0], f.params.grantRefs[0]] },
            { ...f.params, grantRefs: [...f.params.grantRefs].reverse() },
            { ...f.params, payers: [{ payer: f.params.payers[0].payer, amount: 0n }] },
            {
                ...f.params,
                stateCommitments: [f.params.noteCommitment, f.params.stateCommitments[1]],
            },
        ])
            expect(() => api.creditDrawPublicInputs(context, p, f.deliveries)).toThrow();
    });
    it("rejects retired funded creation, payout and remainder fields", () => {
        const f = fixtures.create;
        for (const key of [
            "sources",
            "nullifiers",
            "amount",
            "funding",
            "changeCommitment",
            "expiry",
        ])
            expect(() =>
                api.createCreditPublicInputs(context, { ...f.params, [key]: 0n }, f.deliveries)
            ).toThrow();
        const d = fixtures.draw1;
        for (const key of ["spender", "remainderCommitments", "expiries"])
            expect(() =>
                api.creditDrawPublicInputs(context, { ...d.params, [key]: [] }, d.deliveries)
            ).toThrow();
    });
    it("requires explicit timestamp and binds public periods to draw authorization", () => {
        const f = fixtures.draw1;
        expect(() =>
            api.creditDrawPublicInputs({ ...context, timestamp: undefined }, f.params, f.deliveries)
        ).toThrow();
        expect(
            api.creditDrawPublicInputs(
                { ...context, timestamp: context.timestamp + 86400n },
                f.params,
                f.deliveries
            )
        ).not.toEqual(f.publicInputs);
    });
    it("revokes with public owner authorization and no proof", () => {
        const p = {
            token: context.tokenAddress,
            owner: fixtures.create.params.owner,
            shard: 1n,
            slot: 0n,
            deadline: 900n,
        };
        const typed = api.encodeRevokeCreditTypedData(context, p);
        expect(typed.primaryType).toBe("RevokeCredit");
        expect(typed.types.RevokeCredit.map((x) => x.name)).toEqual([
            "token",
            "owner",
            "shard",
            "slot",
            "deadline",
            "feeRecipient",
            "feeAmount",
        ]);
        const call = api.buildRevokeCreditCalldata({
            context,
            params: p,
            signature: "0x",
            caller: p.owner,
        });
        expect(iface.parseTransaction({ data: call.data })!.name).toBe("revokeCredit");
        expect(() =>
            api.buildRevokeCreditCalldata({ context, params: p, signature: "0x" })
        ).toThrow(/owner/);
        expect(
            api.buildRevokeCreditCalldata({ context, params: p, signature: "0x1234" }).approveAmount
        ).toBe(0n);
    });
    it("selects exactly the13 current direct draw capacities", () => {
        expect(api.CREDIT_DRAW_CAPACITIES).toEqual([1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80]);
        for (const n of [0, 81, 1.1]) expect(() => api.selectCreditDrawCircuit(n)).toThrow();
    });
});
