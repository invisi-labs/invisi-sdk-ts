import { Interface } from "ethers";

import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import {
    computeCreditCommitment,
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
async function creditFixture(amount = 100n, sameWallet = false) {
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
            amount,
            nonce: 456n,
            expiry: 2000003600n,
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
            await computeCreditSharedKeyHash(n.creditSharedKey)
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
it("creates a privately funded Credit with complete dual 400-byte snapshots and ordinary random change", async () => {
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
        400, 400, 158,
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
