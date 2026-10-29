import { Interface } from "ethers";

import { invisiProtocolAbi } from "./contracts";
import {
    buildCancelCreditCalldata,
    buildCreditDrawCalldata,
    buildTopUpCreditCalldata,
    cancelCreditPublicInputs,
    cancelCreditRequestHash,
    creditDrawPublicInputs,
    encodeCancelCreditTypedData,
    encodeCreditDrawTypedData,
    encodeTopUpCreditFundingTypedData,
    encodeTopUpCreditTypedData,
    selectCreditDrawCircuit,
    topUpCreditPublicInputs,
    topUpCreditRequestHash,
} from "@invisi-labs/protocol";
import { describe, expect, it } from "vitest";
import vectors from "./protocol-vectors.json";
const revive = (v: unknown): any =>
    Array.isArray(v)
        ? v.map(revive)
        : v && typeof v === "object"
          ? Object.fromEntries(
                Object.entries(v).map(([k, v]) => [k, k === "version" ? v : revive(v)])
            )
          : typeof v === "string" && /^\d+$/.test(v)
            ? BigInt(v)
            : v;
const { context, fixtures } = revive(vectors);
describe("current credit lifecycle reference vectors", () => {
    for (const n of [1, 2, 13, 51])
        it(`matches draw tier for ${n} inputs`, () => {
            const f = fixtures["draw" + n];
            expect(creditDrawPublicInputs(context, f.params, f.deliveries)).toEqual(f.publicInputs);
            expect(creditDrawPublicInputs(context, f.params, f.deliveries)).toHaveLength(
                6 * selectCreditDrawCircuit(n).maxSize + 14
            );
            expect(encodeCreditDrawTypedData(context, f.params, f.deliveries)).toEqual(f.typedData);
        });
    it("matches cancellation request hash, private wallet authorization and public input order", () => {
        const f = fixtures.cancel;
        expect(cancelCreditPublicInputs(context, f.params)).toEqual(f.publicInputs);
        expect(cancelCreditRequestHash(f.params)).toBe(f.requestHash);
        expect(encodeCancelCreditTypedData(context, f.params)).toEqual(f.typedData);
    });
    it("matches top-up hash and previous expiry at base public input 48", () => {
        const f = fixtures.topUp;
        expect(topUpCreditPublicInputs(context, f.params, f.deliveries, f.funding)).toEqual(
            f.publicInputs
        );
        expect(topUpCreditRequestHash(f.params, f.deliveries, f.funding)).toBe(f.requestHash);
        expect(encodeTopUpCreditTypedData(context, f.params, f.deliveries, f.funding)).toEqual(
            f.typedData
        );
        expect(
            encodeTopUpCreditFundingTypedData(context, f.params, f.deliveries, f.funding)
        ).toEqual(f.fundingTypedData);
    });
    it("selects current credit capacities", () =>
        expect([1, 2, 12, 13, 50, 51, 120].map((n) => selectCreditDrawCircuit(n).maxSize)).toEqual([
            1, 12, 12, 50, 50, 120, 120,
        ]));
    it("requires two empty delivery slots for each fully drawn Credit", () => {
        const f = fixtures.draw1;
        expect(f.deliveries).toEqual([
            { ciphertext: "0x", clue: "0x" },
            { ciphertext: "0x", clue: "0x" },
        ]);
        for (const deliveries of [
            [],
            f.deliveries.slice(0, 1),
            [...f.deliveries, f.deliveries[0]],
            fixtures.create.deliveries.slice(0, 2),
        ]) {
            expect(() => creditDrawPublicInputs(context, f.params, deliveries)).toThrow();
        }
        const partial = {
            token: "0x2222222222222222222222222222222222222222" as const,
            ...f.params,
            remainderCommitments: [fixtures.create.params.creditCommitment],
        };
        expect(() => creditDrawPublicInputs(context, partial, f.deliveries)).toThrow();
        expect(
            creditDrawPublicInputs(context, partial, fixtures.create.deliveries.slice(0, 2))
        ).toHaveLength(20);
    });
    it("encodes draw and top-up with current direct Credit proof frames", () => {
        const draw = fixtures.draw1,
            top = fixtures.topUp;
        expect(
            buildCreditDrawCalldata({
                context,
                proof: "0x1234",
                params: draw.params,
                deliveries: draw.deliveries,
            }).data
        ).toBe(draw.calldata);
        expect(
            buildTopUpCreditCalldata({
                context,
                proof: "0x1234",
                params: top.params,
                deliveries: top.deliveries,
                funding: { ...top.funding, signature: "0xabcd" },
            }).data
        ).toBe(top.calldata);
    });
    it("encodes cancellation against current protocol", () => {
        const r = buildCancelCreditCalldata({
            context,
            proof: "0x1234",
            params: fixtures.cancel.params,
        });
        expect(r.data).toBe(fixtures.cancel.calldata);
    });
});

// The supplied proof contains private wallet authorization for the selected public payout.
describe("wallet-authorized collection and lifecycle boundaries", () => {
    it("collects complete source balances and rejects wrong witnesses or partial payouts", async () => {
        const { computeNoteIdentity, computeNoteCommitment, computeNoteNullifier } =
            await import("@invisi-labs/core");
        const { buildWithdrawalCalldata } = await import("@invisi-labs/protocol");
        const note = {
            chainId: context.chainId,
            protocolAddress: BigInt(context.protocolAddress),
            walletIdentity: ("0x" + 23n.toString(16).padStart(40, "0")) as `0x${string}`,
            tokenAddress: BigInt(context.tokenAddress),
            amount: 100n,
            nonce: 42n,
        };
        const nonce = note.nonce;
        const leaf = await computeNoteCommitment(
            context.chainId,
            await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce),
            note.tokenAddress,
            note.amount
        );
        const nullifier = await computeNoteNullifier(context.chainId, nonce, leaf);
        const params = {
            token: "0x2222222222222222222222222222222222222222" as const,
            sources: [fixtures.cancel.params.source],
            nullifiers: [nullifier],
            outputCommitments: [],
            withdrawalAddress: context.protocolAddress,
            withdrawalAmount: 100n,
            deadline: 900n,
        };
        const input = {
            context,
            proof: "0x1234" as const,
            params,
            sourceNotes: [note],
        };
        expect(
            new Interface(invisiProtocolAbi).parseTransaction({
                data: (await buildWithdrawalCalldata(input)).data,
            })!.name
        ).toBe("transact");
        // Payout is selected by the proof; it is independent from the wallet identity.
        expect(
            new Interface(invisiProtocolAbi).parseTransaction({
                data: (
                    await buildWithdrawalCalldata({
                        ...input,
                        params: { ...params, withdrawalAddress: context.tokenAddress },
                    })
                ).data,
            })!.name
        ).toBe("transact");
        for (const wrong of [
            { ...note, chainId: note.chainId + 1n },
            { ...note, protocolAddress: note.protocolAddress + 1n },
            {
                ...note,
                walletIdentity: ("0x" + 24n.toString(16).padStart(40, "0")) as `0x${string}`,
            },
            { ...note, tokenAddress: note.tokenAddress + 1n },
        ]) {
            await expect(
                buildWithdrawalCalldata({ ...input, sourceNotes: [wrong] })
            ).rejects.toThrow();
        }
        await expect(
            buildWithdrawalCalldata({ ...input, params: { ...params, withdrawalAmount: 50n } })
        ).rejects.toThrow();
        await expect(
            buildWithdrawalCalldata({
                ...input,
                sourceNotes: [{ ...note, nonce: note.nonce + 1n }],
            })
        ).rejects.toThrow();
        await expect(buildWithdrawalCalldata({ ...input, sourceNotes: [] })).rejects.toThrow();
        expect("buildUnsignedWithdrawalCalldata" in (await import("@invisi-labs/protocol"))).toBe(
            false
        );
    });
    it("rejects stale top-ups, decreasing expiry, duplicate credit nullifier and full-draw recovery", () => {
        const top = fixtures.topUp,
            draw = fixtures.draw1;
        expect(() =>
            topUpCreditPublicInputs(
                { ...context, now: 951n },
                top.params,
                top.deliveries,
                top.funding
            )
        ).toThrow("deadline");
        expect(() =>
            topUpCreditPublicInputs(
                context,
                { ...top.params, previousExpiry: 1001n },
                top.deliveries,
                top.funding
            )
        ).toThrow("decrease");
        expect(() =>
            topUpCreditPublicInputs(
                context,
                {
                    ...top.params,
                    creation: {
                        token: "0x2222222222222222222222222222222222222222" as const,
                        ...top.params.creation,
                        sources: fixtures.single.params.sources,
                        nullifiers: [top.params.creditNullifier],
                    },
                },
                top.deliveries,
                top.funding
            )
        ).toThrow();
        expect(() =>
            creditDrawPublicInputs(
                context,
                {
                    ...draw.params,
                    recoveryAmounts: ["0x" + 1n.toString(16).padStart(64, "0")],
                },
                draw.deliveries
            )
        ).toThrow("zero recovery");
        expect(() =>
            creditDrawPublicInputs(context, { ...draw.params, expiries: [0n] }, draw.deliveries)
        ).toThrow("future");
    });
});

describe("top-up incremental value requirement", () => {
    it("rejects prior-credit-only top-ups at validation, public-input and calldata boundaries", async () => {
        const { validateTopUpCreditRequest } = await import("@invisi-labs/protocol");
        const top = fixtures.topUp;
        expect(() => validateTopUpCreditRequest(context, top.params, top.deliveries)).toThrow(
            "positive funding"
        );
        expect(() => topUpCreditPublicInputs(context, top.params, top.deliveries)).toThrow(
            "positive funding"
        );
        expect(() =>
            buildTopUpCreditCalldata({
                context,
                proof: "0x1234",
                params: top.params,
                deliveries: top.deliveries,
            })
        ).toThrow("positive funding");
    });
    it("retains notes-only and mixed top-ups", async () => {
        const { validateTopUpCreditRequest } = await import("@invisi-labs/protocol"),
            top = fixtures.topUp,
            params = {
                ...top.params,
                creation: {
                    token: "0x2222222222222222222222222222222222222222" as const,
                    ...top.params.creation,
                    sources: fixtures.single.params.sources,
                    nullifiers: ["0x" + 22n.toString(16).padStart(64, "0")],
                },
            };
        for (const funding of [undefined, { payer: context.protocolAddress, amount: 1n }]) {
            expect(
                validateTopUpCreditRequest(context, params, top.deliveries, funding).creation
                    .nullifiers
            ).toHaveLength(1);
            expect(topUpCreditPublicInputs(context, params, top.deliveries, funding)).toHaveLength(
                50
            );
            expect(
                new Interface(invisiProtocolAbi).parseTransaction({
                    data: buildTopUpCreditCalldata({
                        context,
                        proof: "0x1234",
                        params,
                        deliveries: top.deliveries,

                        ...(funding ? { funding } : {}),
                    }).data,
                })!.name
            ).toBe("topUpCredit");
        }
    });
});

describe("top-up submission funding expiry", () => {
    it("rejects expired signed funding, accepts equality and preserves direct payer metadata", () => {
        const top = fixtures.topUp,
            p = {
                context: { ...context, now: 800n },
                proof: "0x1234" as const,
                params: top.params,
                deliveries: top.deliveries,
            },
            signed = { ...top.funding, signature: "0xabcd" };
        expect(() =>
            buildTopUpCreditCalldata({ ...p, funding: { ...signed, deadline: 799n } })
        ).toThrow("funding authorization has expired");
        expect(
            buildTopUpCreditCalldata({ ...p, funding: { ...signed, deadline: 800n } }).data
        ).toMatch(/^0x/);
        expect(
            buildTopUpCreditCalldata({
                ...p,
                funding: { payer: context.protocolAddress, amount: 100n },
            }).data
        ).toMatch(/^0x/);
    });
});
