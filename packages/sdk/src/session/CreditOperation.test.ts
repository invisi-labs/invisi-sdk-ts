import { Interface } from "ethers";

import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import {
    computeCreditCommitment,
    creditPeriods,
    normalizeCreditPolicy,
    type CreditPolicy,
    computeCreditSharedKeyHash,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import type { Prover } from "@invisi-labs/prover";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { expect, it, vi } from "vitest";
import { WalletSession } from "./WalletSession";
import { canonicalBlock, fixture, receiptLog } from "./operation-fixture";
import type { SavedOperation } from "./operation-types";
const addressA = "0x3333333333333333333333333333333333333333" as const,
    addressB = "0x4444444444444444444444444444444444444444" as const;
const backend = (): Prover => ({
    prove: async (request) => ({
        ...request,
        formatVersion: 1,
        bbVersion: "6.0.0",
        proofHex: "0x00",
        proofSha256: bytesToHex(sha256(new Uint8Array([0]))),
        publicInputs: [...request.expectedPublicInputs],
    }),
    verify: async () => true,
});
async function creditFixture(
    amount = 100n,
    sameWallet = false,
    memo?: string | Uint8Array,
    policy: Partial<CreditPolicy> = {},
    expiry = 2000003600n
) {
    const h = await fixture();
    if (sameWallet) h.bob = h.wallet;
    const state: CreditDeliveryState = {
        note: {
            chainId: h.scope.chainId,
            protocolAddress: BigInt(h.scope.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            ownerWalletIdentity: h.wallet.walletIdentity,
            spenderWalletIdentity: h.bob.walletIdentity,
            ownerPayout: BigInt(h.wallet.walletIdentity),
            spenderPayout: BigInt(h.bob.walletIdentity),
            ...normalizeCreditPolicy(policy),
            amount,
            ...(memo === undefined ? {} : { memo }),
            nonce: 456n,
            expiry,
            creditSharedKey: 789n,
        },
        ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
        spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
    };
    const n = state.note,
        commitment = await computeCreditCommitment(
            n.chainId,
            n.spenderWalletIdentity,
            n.ownerWalletIdentity,
            n.spenderPayout,
            n.ownerPayout,
            n.tokenAddress,
            n.amount,
            n.nonce,
            n.expiry,
            await computeCreditSharedKeyHash(n.creditSharedKey),
            n
        );
    await h.tree.insert(BigInt(commitment));
    const block = await h.reader.getBlock(12n);
    for (const [wallet, role] of [
        [h.wallet, "owner"],
        [h.bob, "spender"],
    ] as const) {
        const scope = { ...h.scope, walletIdentity: wallet.walletIdentity };
        await h.store.transaction(scope, (draft) => {
            draft.credits[commitment + ":" + role] = {
                state,
                role,
                commitment,
                treeId: 1n,
                leafIndex: 1,
                blockNumber: 12n,
                blockHash: block.hash,
                spent: "unspent",
            };
        });
    }
    return {
        ...h,
        state,
        commitment,
        ownerSession: new WalletSession({ ...h.options, prover: backend() }),
        spenderSession: new WalletSession({ ...h.options, wallet: h.bob, prover: backend() }),
    };
}
it("creates a privately funded Credit with complete dual 498-byte snapshots and ordinary random change", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: backend() }),
        operation = await session.prepareCreateCredit({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            spender: h.bob.getAddress(),
            amount: 70n,
            expiry: 2000003600n,
        });
    const saved = (await h.store.readSnapshot(h.scope)).operations[operation.id]!
            .payload as SavedOperation,
        credit = saved.plan.credit!;
    expect(credit.outputs[0]!.state.note.amount).toBe(70n);
    expect(saved.plan.outputs[0]!.note.amount).toBe(30n);
    expect(credit.deliveries.map((delivery) => (delivery.ciphertext.length - 2) / 2)).toEqual([
        498, 498, 161,
    ]);
    const recovered = await h.bob.getViewer().decryptCredit(credit.deliveries[1]!.ciphertext, {
        chainId: h.scope.chainId,
        protocolAddress: BigInt(h.scope.protocolAddress),
        tokenAddress: BigInt(h.context.tokenAddress),
        outputCommitment: credit.outputs[0]!.commitment,
        role: "spender",
    });
    expect(recovered).toEqual(credit.outputs[0]!.state);
    const ready = await (await operation.authorize()).prove();
    expect(ready.status).toBe("ready");
    const encoded = (
        (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as SavedOperation
    ).call!;
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: encoded.data })!.name).toBe(
        "createCredit"
    );
    expect(JSON.stringify(operation)).not.toMatch(/creditSharedKey|nonce|amount/);
});
it("draws only as the spender, preserves both snapshots and never resolves current registry keys", async () => {
    const h = await creditFixture(),
        lookup = vi.fn(async () => {
            throw new Error("unexpected lookup");
        }),
        session = new WalletSession({
            ...h.options,
            wallet: h.bob,
            prover: backend(),
            addressResolver: lookup,
        });
    const operation = await session.prepareDrawCredit({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            credits: [{ credit: h.commitment, amount: 30n }],
        }),
        scope = { ...h.scope, walletIdentity: h.bob.walletIdentity },
        saved = (await h.store.readSnapshot(scope)).operations[operation.id]!
            .payload as SavedOperation;
    const remainder = saved.plan.credit!.outputs[0]!.state;
    expect(remainder.note.amount).toBe(70n);
    expect(remainder.ownerReceivingKeys).toEqual(h.state.ownerReceivingKeys);
    expect(remainder.spenderReceivingKeys).toEqual(h.state.spenderReceivingKeys);
    expect(lookup).not.toHaveBeenCalled();
    const ready = await (await operation.authorize()).prove();
    expect(ready.status).toBe("ready");
    const encoded = (
        (await h.store.readSnapshot(scope)).operations[ready.id]!.payload as SavedOperation
    ).call!;
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: encoded.data })!.name).toBe(
        "creditDraw"
    );
    await expect(
        h.ownerSession.prepareDrawCredit({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            credits: [{ credit: h.commitment, amount: 30n }],
        })
    ).rejects.toThrow(/spender|confirmed|Credit/);
});
it("tops up only before expiry, inherits receiving snapshots, and cancels the public refund after expiry", async () => {
    const h = await creditFixture(),
        operation = await h.ownerSession.prepareTopUpCredit({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            credit: h.commitment,
            additionalAmount: 80n,
            expiry: 2000007200n,
        });
    const saved = (await h.store.readSnapshot(h.scope)).operations[operation.id]!
            .payload as SavedOperation,
        note = saved.plan.credit!.outputs[0]!.state.note;
    expect(note.amount).toBe(180n);
    expect(note.expiry).toBe(2000007200n);
    expect(note.creditSharedKey).toBe(h.state.note.creditSharedKey);
    expect(saved.plan.outputs[0]!.note.amount).toBe(20n);
    const ready = await (await operation.authorize()).prove();
    expect(ready.status).toBe("ready");
    const encoded = (
        (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as SavedOperation
    ).call!;
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: encoded.data })!.name).toBe(
        "topUpCredit"
    );
    await (await h.ownerSession.resume(operation.id)).abandon();
    const block = h.reader.getBlock;
    h.reader.getBlock = async (n) => ({ ...(await block(n)), timestamp: 2000003601n });
    await expect(
        h.ownerSession.prepareTopUpCredit({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            credit: h.commitment,
            additionalAmount: 80n,
            expiry: 2000007200n,
        })
    ).rejects.toThrow(/expired/);
    const cancel = await h.ownerSession.prepareCancelCredit({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        credit: h.commitment,
    });
    const readyCancel = await (await cancel.authorize()).prove();
    expect(readyCancel.status).toBe("ready");
    const encodedCancel = (
        (await h.store.readSnapshot(h.scope)).operations[readyCancel.id]!.payload as SavedOperation
    ).call!;
    expect(
        new Interface(invisiProtocolAbi).parseTransaction({ data: encodedCancel.data })!.name
    ).toBe("cancelCredit");
});

it.each(["cancel", "top-up"] as const)(
    "reserves the same Credit input across spender draw and owner %s",
    async (kind) => {
        const h = await creditFixture(100n, true),
            draw = await h.spenderSession.prepareDrawCredit({
                tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                credits: [{ credit: h.commitment, amount: 30n }],
            });
        const competing = () =>
            kind === "cancel"
                ? h.ownerSession.prepareCancelCredit({
                      tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                      credit: h.commitment,
                  })
                : h.ownerSession.prepareTopUpCredit({
                      tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                      credit: h.commitment,
                      additionalAmount: 10n,
                  });
        await expect(competing()).rejects.toThrow(/reserved|unavailable/);
        await draw.abandon();
        const owner = await competing();
        await owner.abandon();
        expect(
            (
                await h.spenderSession.prepareDrawCredit({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    credits: [{ credit: h.commitment, amount: 10n }],
                })
            ).status
        ).toBe("prepared");
    }
);
it("merges duplicate Credit spent facts for both roles without reverting newer observations", async () => {
    const { mergeReceiptRecords } = await import("./receipts"),
        h = await creditFixture(100n, true);
    const original = await h.store.readSnapshot(h.scope),
        records = Object.values(original.credits);
    await h.store.transaction(h.scope, (state) =>
        mergeReceiptRecords(state, {
            notes: [],
            credits: records.map((record) => ({
                ...record,
                spent: "spent",
                checkedThrough: { number: 20n, hash: `0x${"14".padStart(64, "0")}` },
            })),
            checkpoint: { number: 12n, hash: original.observedThrough!.hash },
        })
    );
    await h.store.transaction(h.scope, (state) =>
        mergeReceiptRecords(state, {
            notes: [],
            credits: records.map((record) => ({
                ...record,
                spent: "unspent",
                checkedThrough: { number: 13n, hash: `0x${"13".padStart(64, "0")}` },
            })),
            checkpoint: { number: 12n, hash: original.observedThrough!.hash },
        })
    );
    const updated = Object.values((await h.store.readSnapshot(h.scope)).credits);
    expect(updated).toHaveLength(2);
    expect(
        updated.every((record) => record.spent === "spent" && record.checkedThrough!.number === 20n)
    ).toBe(true);
});

it("late Credit confirmation updates both stored roles, releases their shared lock and restores it on reorg", async () => {
    const h = await creditFixture(100n, true),
        ready = await (
            await (
                await h.spenderSession.prepareDrawCredit({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    credits: [{ credit: h.commitment, amount: 30n }],
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"a2".repeat(32)}` as const;
    const plan = (
            (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as SavedOperation
        ).plan,
        output = plan.credit!.outputs[0]!;
    await h.tree.insert(BigInt(output.commitment));
    await h.store.transaction(h.scope, (state) => {
        for (const role of ["owner", "spender"] as const)
            state.credits[output.commitment + ":" + role] = {
                state: output.state,
                role,
                commitment: output.commitment,
                treeId: 1n,
                leafIndex: 2,
                blockNumber: 13n,
                blockHash: canonicalBlock(13n).hash,
                spent: "unspent",
                checkedThrough: canonicalBlock(13n),
            };
        state.observedThrough = canonicalBlock(13n);
    });
    h.reader.getBlock = async (n) => canonicalBlock(n);
    h.reader.getLatestBlockNumber = async () => 20n;
    h.reader.isSpent = async (_, words) => words.map(() => true);
    h.membership.getMembership = async (_, input, block) => {
        const path = h.tree.getProof(input.leafIndex);
        return {
            treeId: input.treeId,
            leafIndex: input.leafIndex,
            leaf: input.commitment,
            root: `0x${path.root.toString(16).padStart(64, "0")}`,
            path: path.merklePath,
            block,
        };
    };
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: addressA,
        nonce: 0n,
    });
    const logs = [
        await receiptLog(
            "CommitmentsInserted",
            { treeId: 1n, startLeafIndex: 2, commitments: [output.commitment] },
            0,
            hash
        ),
        await receiptLog(
            "CreditDraw",
            {
                spender: addressB,
                outputTreeId: 1n,
                params: plan.credit!.draw,
                remainderLeafIndices: [2],
                deliveries: plan.credit!.deliveries,
            },
            1,
            hash
        ),
    ];
    h.reader.getReceipt = async () => ({
        block: canonicalBlock(13n),
        transactionHash: hash,
        status: "success",
        logs,
    });
    const confirmed = await ready.reconcile({ transactionHash: hash }),
        state = await h.store.readSnapshot(h.scope);
    expect(confirmed.status).toBe("confirmed");
    expect(
        Object.values(state.credits).every(
            (record) => record.spent === "spent" && record.checkedThrough!.number === 20n
        )
    ).toBe(true);
    expect(state.reservations["credit:" + h.commitment]).toBeUndefined();
    h.reader.getBlock = async (n) => ({ ...canonicalBlock(n), hash: `0x${"ff".repeat(32)}` });
    await expect(confirmed.reconcile()).rejects.toThrow(/canonical|resync/);
    expect((await h.store.readSnapshot(h.scope)).reservations["credit:" + h.commitment]).toBe(
        ready.id
    );
});
it("normalizes direct reservation requests to one underlying Credit across role aliases", async () => {
    const { reserveInputs, releaseInputs } = await import("./reservations"),
        h = await creditFixture(100n, true);
    await reserveInputs(h.store, h.scope, "owner-operation", [h.commitment + ":owner"]);
    await expect(
        reserveInputs(h.store, h.scope, "spender-operation", [h.commitment + ":spender"])
    ).rejects.toThrow(/unavailable/);
    await releaseInputs(h.store, h.scope, "owner-operation");
    await reserveInputs(h.store, h.scope, "spender-operation", [h.commitment + ":spender"]);
    expect((await h.store.readSnapshot(h.scope)).reservations["credit:" + h.commitment]).toBe(
        "spender-operation"
    );
});

it("preserves Credit memos by default and applies top-up and per-remainder overrides", async () => {
    for (const override of [undefined, "replacement", new Uint8Array([0, 255]), ""]) {
        const h = await creditFixture(100n, false, new Uint8Array([65, 0, 255]));
        const tokenAddress = h.context.tokenAddress;
        const request = {
            tokenAddress,
            credit: h.commitment,
            additionalAmount: 10n,
            ...(override === undefined ? {} : { memo: override }),
        };
        const topUp = await h.ownerSession.prepareTopUpCredit(request);
        const topPlan = (
            (await h.store.readSnapshot(h.scope)).operations[topUp.id]!.payload as SavedOperation
        ).plan;
        const expected =
            override === undefined
                ? new Uint8Array([65, 0, 255])
                : typeof override === "string"
                  ? new TextEncoder().encode(override)
                  : override;
        if (expected.length === 0)
            expect(topPlan.credit!.outputs[0]!.state.note).not.toHaveProperty("memo");
        else expect(topPlan.credit!.outputs[0]!.state.note.memo).toEqual(expected);
        await topUp.abandon();
        const draw = await h.spenderSession.prepareDrawCredit({
            tokenAddress,
            credits: [
                {
                    credit: h.commitment,
                    amount: 30n,
                    ...(override === undefined ? {} : { memo: override }),
                },
            ],
        });
        const scope = { ...h.scope, walletIdentity: h.bob.walletIdentity };
        const drawPlan = (
            (await h.store.readSnapshot(scope)).operations[draw.id]!.payload as SavedOperation
        ).plan;
        for (const role of ["owner", "spender"] as const) {
            const wallet = role === "owner" ? h.wallet : h.bob;
            const result = await wallet
                .getViewer()
                .decryptCredit(
                    drawPlan.credit!.outputs[0]!.deliveries[role === "owner" ? 0 : 1].ciphertext,
                    {
                        ...h.context,
                        protocolAddress: BigInt(h.context.protocolAddress),
                        tokenAddress: BigInt(tokenAddress),
                        role,
                        outputCommitment: drawPlan.credit!.outputs[0]!.commitment,
                    }
                );
            if (expected.length === 0) expect(result.note).not.toHaveProperty("memo");
            else expect(result.note.memo).toEqual(expected);
        }
    }
});

it("applies private per-input limits before full draws and preserves counters through top-up", async () => {
    const periods = creditPeriods(2000000000n);
    const policy = {
        singleLimit: 40n,
        dailyLimit: 60n,
        monthlyLimit: 90n,
        lastDay: periods.currentDay,
        dailySpent: 10n,
        lastMonth: periods.currentMonth,
        monthlySpent: 20n,
    };
    const h = await creditFixture(100n, false, undefined, policy);
    await expect(
        h.spenderSession.prepareDrawCredit({
            tokenAddress: h.context.tokenAddress,
            credits: [{ credit: h.commitment, amount: 100n }],
        })
    ).rejects.toThrow("single limit");
    const draw = await h.spenderSession.prepareDrawCredit({
        tokenAddress: h.context.tokenAddress,
        credits: [{ credit: h.commitment, amount: 30n }],
    });
    const scope = { ...h.scope, walletIdentity: h.bob.walletIdentity };
    const plan = (
        (await h.store.readSnapshot(scope)).operations[draw.id]!.payload as SavedOperation
    ).plan;
    expect(plan.credit!.outputs[0]!.state.note).toMatchObject({
        ...policy,
        dailySpent: 40n,
        monthlySpent: 50n,
    });
    expect(plan.statement!.expectedPublicInputs).toHaveLength(20);
    await draw.abandon();
    const top = await h.ownerSession.prepareTopUpCredit({
        tokenAddress: h.context.tokenAddress,
        credit: h.commitment,
        additionalAmount: 10n,
    });
    const topped = (
        (await h.store.readSnapshot(h.scope)).operations[top.id]!.payload as SavedOperation
    ).plan;
    expect(topped.credit!.outputs[0]!.state.note).toMatchObject({ ...policy, amount: 110n });
});

it("expires a prepared draw when chain time crosses a UTC period even before its deadline", async () => {
    const h = await creditFixture(100n, false, undefined, {}, 2000100000n);
    const draw = await h.spenderSession.prepareDrawCredit({
        tokenAddress: h.context.tokenAddress,
        credits: [{ credit: h.commitment, amount: 30n }],
        deadline: 2000100000n,
    });
    const ready = await (await draw.authorize()).prove();
    const original = await h.reader.getBlock(12n);
    // The next UTC day is before this Credit's expiry and the explicit deadline.
    const nextDay = (original.timestamp / 86400n + 1n) * 86400n;
    h.reader.getBlock = async () => ({ ...original, timestamp: nextDay });
    await expect(ready.exportTransaction()).rejects.toThrow("expired");
});

it.skipIf(!process.env.BB_BINARY_PATH).each(["draw", "top-up"] as const)(
    "proves and independently verifies enabled %s using the production preparation and WitnessBuilder",
    async (kind) => {
        const { NativeProver } = await import("@invisi-labs/prover/native");
        const periods = creditPeriods(2000000000n);
        const policy = {
            singleLimit: 40n,
            dailyLimit: 60n,
            monthlyLimit: 90n,
            lastDay: periods.currentDay,
            dailySpent: 10n,
            lastMonth: periods.currentMonth,
            monthlySpent: 20n,
        };
        const h = await creditFixture(100n, false, undefined, policy);
        const session = new WalletSession({
            ...h.options,
            wallet: kind === "draw" ? h.bob : h.wallet,
            prover: new NativeProver({ bbBin: process.env.BB_BINARY_PATH!, threads: 4 }),
        });
        const operation =
            kind === "draw"
                ? await session.prepareDrawCredit({
                      tokenAddress: h.context.tokenAddress,
                      credits: [{ credit: h.commitment, amount: 30n }],
                  })
                : await session.prepareTopUpCredit({
                      tokenAddress: h.context.tokenAddress,
                      credit: h.commitment,
                      additionalAmount: 10n,
                      singleLimit: 10n,
                      dailyLimit: 5n,
                      monthlyLimit: 0n,
                  });
        const ready = await (await operation.authorize()).prove();
        expect(ready.status).toBe("ready");
        const scope = {
            ...h.scope,
            walletIdentity: kind === "draw" ? h.bob.walletIdentity : h.wallet.walletIdentity,
        };
        const saved = (await h.store.readSnapshot(scope)).operations[ready.id]!
            .payload as SavedOperation;
        expect(saved.plan.credit!.outputs[0]!.state.note).toMatchObject(
            kind === "draw"
                ? { ...policy, amount: 70n, dailySpent: 40n, monthlySpent: 50n }
                : { ...policy, singleLimit: 10n, dailyLimit: 5n, monthlyLimit: 0n, amount: 110n }
        );
        expect(saved.plan.statement!.expectedPublicInputs).toHaveLength(kind === "draw" ? 20 : 50);
        expect((await ready.exportTransaction()).data).toMatch(/^0x/);
    },
    120000
);

it("owner top-up replaces limits, treats zero as disable and keeps already-used counters even below the new limit", async () => {
    const periods = creditPeriods(2000000000n);
    const policy = {
        singleLimit: 40n,
        dailyLimit: 60n,
        monthlyLimit: 90n,
        lastDay: periods.currentDay,
        dailySpent: 10n,
        lastMonth: periods.currentMonth,
        monthlySpent: 20n,
    };
    const h = await creditFixture(100n, false, undefined, policy);
    const top = await h.ownerSession.prepareTopUpCredit({
        tokenAddress: h.context.tokenAddress,
        credit: h.commitment,
        additionalAmount: 10n,
        singleLimit: 10n,
        dailyLimit: 5n,
        monthlyLimit: 0n,
    });
    const saved = (await h.store.readSnapshot(h.scope)).operations[top.id]!
        .payload as SavedOperation;
    expect(saved.plan.credit!.outputs[0]!.state.note).toMatchObject({
        ...policy,
        singleLimit: 10n,
        dailyLimit: 5n,
        monthlyLimit: 0n,
        amount: 110n,
    });
    expect((await (await top.authorize()).prove()).status).toBe("ready");
});
it("disabled limits count consumption so later re-enabling cannot hide prior draws", async () => {
    const periods = creditPeriods(2000000000n);
    const h = await creditFixture(100n, false, undefined, {
        lastDay: periods.currentDay,
        dailySpent: 10n,
        lastMonth: periods.currentMonth,
        monthlySpent: 20n,
    });
    const draw = await h.spenderSession.prepareDrawCredit({
        tokenAddress: h.context.tokenAddress,
        credits: [{ credit: h.commitment, amount: 30n }],
    });
    const scope = { ...h.scope, walletIdentity: h.bob.walletIdentity };
    const saved = (await h.store.readSnapshot(scope)).operations[draw.id]!
        .payload as SavedOperation;
    expect(saved.plan.credit!.outputs[0]!.state.note).toMatchObject({
        singleLimit: 0n,
        dailyLimit: 0n,
        monthlyLimit: 0n,
        dailySpent: 40n,
        monthlySpent: 50n,
    });
});
