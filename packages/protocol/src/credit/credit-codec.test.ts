import { it, expect, describe } from "vitest";
import { Interface, TypedDataEncoder } from "ethers";
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
const { context, fixtures } = revive(raw),
    iface = new Interface(invisiCoreAbi);
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
                build({
                    context,
                    params: f.params,
                    deliveries: f.deliveries,
                    proof: "0x1234",
                }).data
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
            expect(f.publicInputs).toHaveLength(17 + 9 * api.selectCreditDrawCircuit(n).capacity);
            expect(api.encodeCreditDrawTypedData(context, f.params, f.deliveries)).toEqual(
                f.typedData
            );
            expect(f.params.creditCommitments).toHaveLength(n);
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
                creditCommitments: [f.params.noteCommitment, f.params.creditCommitments[1]],
            },
        ])
            expect(() => api.creditDrawPublicInputs(context, p, f.deliveries)).toThrow();
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
            grantId: 1n,
            deadline: 900n,
        };
        const typed = api.encodeRevokeCreditTypedData(context, p);
        expect(typed.primaryType).toBe("RevokeCredit");
        expect(typed.types.RevokeCredit.map((x) => x.name)).toEqual([
            "token",
            "owner",
            "grantId",
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

it("requires positive uint128 grant IDs in every Credit codec and rejects old namespaces", () => {
    const create = fixtures.create;
    const update = fixtures.update;
    const draw = fixtures.draw1;
    const revoke = {
        token: context.tokenAddress,
        owner: create.params.owner,
        grantId: 1n,
        deadline: create.params.deadline,
    };
    for (const grantId of [0n, -1n, 1n << 128n, 1, "01", "0", "+1", "1.0"]) {
        expect(() =>
            api.createCreditPublicInputs(context, { ...create.params, grantId }, create.deliveries)
        ).toThrow();
        expect(() =>
            api.updateCreditPublicInputs(context, { ...update.params, grantId }, update.deliveries)
        ).toThrow();
        expect(() =>
            api.creditDrawPublicInputs(
                context,
                {
                    ...draw.params,
                    grantRefs: [{ payerIndex: 0n, grantId }],
                },
                draw.deliveries
            )
        ).toThrow();
        expect(() =>
            api.encodeRevokeCreditTypedData(context, { ...revoke, grantId } as never)
        ).toThrow();
    }
    for (const grantId of [1n, (1n << 128n) - 1n]) {
        expect(() =>
            api.createCreditPublicInputs(context, { ...create.params, grantId }, create.deliveries)
        ).not.toThrow();
        expect(() =>
            api.updateCreditPublicInputs(context, { ...update.params, grantId }, update.deliveries)
        ).not.toThrow();
        expect(
            api.encodeRevokeCreditTypedData(context, { ...revoke, grantId }).message.grantId
        ).toBe(grantId);
    }
    expect(() =>
        api.createCreditPublicInputs(
            context,
            {
                ...create.params,
                revocationShard: 1n,
                revocationSlot: 0n,
            },
            create.deliveries
        )
    ).toThrow(/unsupported/);
    expect(() =>
        api.updateCreditPublicInputs(
            context,
            {
                ...update.params,
                revocationShard: 1n,
                revocationSlot: 0n,
            },
            update.deliveries
        )
    ).toThrow(/unsupported/);
    expect(() =>
        api.creditDrawPublicInputs(
            context,
            {
                ...draw.params,
                grantRefs: [{ payerIndex: 0n, shard: 1n, slot: 0n }],
            },
            draw.deliveries
        )
    ).toThrow(/unsupported/);
    expect(() =>
        api.encodeRevokeCreditTypedData(context, {
            ...revoke,
            shard: 1n,
            slot: 0n,
        } as never)
    ).toThrow(/unsupported/);
});

it("scopes equal grant IDs by payer and requires sorted unique refs within each payer", () => {
    const draw = fixtures.draw2;
    const payers = [
        { payer: "0x1111111111111111111111111111111111111111", amount: 1n },
        {
            payer: "0x2222222222222222222222222222222222222222",
            amount: draw.params.totalAmount - 1n,
        },
    ];
    const params = {
        ...draw.params,
        payers,
        grantRefs: [
            { payerIndex: 0n, grantId: 7n },
            { payerIndex: 1n, grantId: 7n },
        ],
    };
    expect(() => api.creditDrawPublicInputs(context, params, draw.deliveries)).not.toThrow();
    expect(() =>
        api.creditDrawPublicInputs(
            context,
            {
                ...params,
                grantRefs: [...params.grantRefs].reverse(),
            },
            draw.deliveries
        )
    ).toThrow(/sorted unique/);
    expect(() =>
        api.creditDrawPublicInputs(
            context,
            {
                ...params,
                grantRefs: [params.grantRefs[0], params.grantRefs[0]],
            },
            draw.deliveries
        )
    ).toThrow(/sorted unique/);
});

it("encodes pre-revocation with the same uint128 owner authorization as active revocation", () => {
    const params = {
        token: context.tokenAddress,
        owner: fixtures.create.params.owner,
        grantId: (1n << 128n) - 1n,
        deadline: fixtures.create.params.deadline,
    };
    const typed = api.encodeRevokeCreditTypedData(context, params);
    expect(typed.types.RevokeCredit.find((field) => field.name === "grantId")?.type).toBe(
        "uint128"
    );
    const signed = api.buildRevokeCreditCalldata({ context, params, signature: "0x1234" });
    const direct = api.buildRevokeCreditCalldata({
        context,
        params,
        signature: "0x",
        caller: params.owner,
    });
    expect(iface.decodeFunctionData("revokeCredit", signed.data)[2]).toBe(params.grantId);
    expect(iface.decodeFunctionData("revokeCredit", direct.data)[2]).toBe(params.grantId);
    expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.message)).toMatch(
        /^0x[0-9a-f]{64}$/
    );
});
