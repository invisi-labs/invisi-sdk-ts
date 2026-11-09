import { PublicWallet } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { expect, it } from "vitest";
import { canonicalBlock, fixture, receiptLog } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";
import { prover, signer } from "./Operation-fixtures";

it("reconciles spent facts at the latest canonical block when confirming an older receipt", async () => {
    const h = await fixture(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: prover() })),
        ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"77".repeat(32)}` as const,
        original = h.reader.getBlock,
        checked: bigint[] = [];
    h.reader.getLatestBlockNumber = async () => 20n;
    h.reader.getBlock = async (n) => ({
        ...(await original(n)),
        number: n,
        hash: `0x${n.toString(16).padStart(64, "0")}`,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words, block) => {
        checked.push(block.number);
        return words.map(() => true);
    };
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    expect(checked).toEqual([20n]);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[h.leaf]!.checkedThrough!.number).toBe(20n);
    expect(state.observedThrough!.number).toBe(20n);
});

it.each(["observedThrough"] as const)(
    "rejects stale reconciliation after concurrent %s advances",
    async (cursor) => {
        const h = await fixture(),
            session = new WalletSession(sessionOptions({ ...h.options, prover: prover() })),
            ready = await (
                await (
                    await session.prepareTransfer({
                        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                        deadline: 2000000050n,
                        outputs: [],
                        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                    })
                ).authorize()
            ).prove();
        await ready.exportTransaction();
        const original = h.reader.getBlock;
        h.reader.getLatestBlockNumber = async () => 13n;
        h.reader.getBlock = async (n) => ({
            ...(await original(n)),
            number: n,
            hash: `0x${n.toString(16).padStart(64, "0")}`,
            timestamp: n === 13n ? 2000000100n : 2000000000n,
        });
        let started!: () => void, release!: () => void;
        const begun = new Promise<void>((resolve) => {
                started = resolve;
            }),
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
        h.reader.isSpent = async (_, words) => {
            started();
            await gate;
            return words.map(() => false);
        };
        const pending = ready.reconcile();
        await begun;
        await h.store.transaction(h.scope, (state) => {
            state.notes[h.leaf]!.spent = "spent";
            state.notes[h.leaf]!.checkedThrough = {
                number: 20n,
                hash: `0x${"14".padStart(64, "0")}`,
            };
            state[cursor] = { number: 20n, hash: `0x${"14".padStart(64, "0")}` };
        });
        release();
        await expect(pending).rejects.toThrow(/advanced|retry/);
        const state = await h.store.readSnapshot(h.scope);
        expect(state.notes[h.leaf]!.spent).toBe("spent");
        expect(state.notes[h.leaf]!.checkedThrough!.number).toBe(20n);
        expect(state.reservations[h.leaf]).toBe(ready.id);
        expect(state.operations[ready.id]!.status).toBe("ready");
    }
);

it("late confirmation updates a previously discovered change note to its current spent state", async () => {
    const h = await fixture(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: prover() })),
        ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: signer.address, amount: 30n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"a1".repeat(32)}` as const;
    const plan = (
            (await h.store.readSnapshot(h.scope)).operations[ready.id]!
                .payload as import("@invisi-labs/sdk/session-support").SavedOperation
        ).plan,
        output = plan.outputs[0]!;
    await h.tree.insert(BigInt(output.commitment));
    await h.store.transaction(h.scope, (state) => {
        state.notes[output.commitment] = {
            note: output.note!,
            commitment: output.commitment,
            treeId: 1n,
            leafIndex: 1,
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
        from: signer.address,
        nonce: 0n,
    });
    const logs = [
        await receiptLog(
            "CommitmentsInserted",
            { treeId: 1n, startLeafIndex: 1, commitments: [output.commitment] },
            0,
            hash
        ),
        await receiptLog(
            "Transact",
            {
                token: "0x2222222222222222222222222222222222222222" as const,
                inputTreeId: 1n,
                outputTreeId: 1n,
                nullifiers: plan.params!.nullifiers,
                noteCommitments: [output.commitment],
                leafIndices: [1],
                deliveries: [output.delivery],
                withdrawalAddress: signer.address,
                withdrawalAmount: 30n,
                deadline: plan.deadline,
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
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[output.commitment]!.spent).toBe("spent");
    expect(state.notes[output.commitment]!.checkedThrough!.number).toBe(20n);
    expect(
        (await session.balance("0x2222222222222222222222222222222222222222")).availableKnown
    ).toBe(0n);
});

it("tracks an application transaction hash without broadcasting and keeps reservations across restart", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    const call = await ready.exportTransaction();
    expect(call.to).toBe(h.protocol.context.protocolAddress);
    const hash = `0x${"ab".repeat(32)}`;
    const tracked = await ready.trackTransaction(hash);
    expect(tracked.status).toBe("uncertain");
    expect(tracked).not.toHaveProperty("submit");
    expect(tracked).not.toHaveProperty("wait");
    const state = await h.store.readSnapshot(h.scope);
    expect(state.operations[ready.id]!.transactionHash).toBe(hash);
    expect(state.reservations[h.leaf]).toBe(ready.id);
    await expect(tracked.abandon()).rejects.toThrow(/externalized/);
    const resumed = await session.resume(ready.id);
    await expect(tracked.trackTransaction(hash)).rejects.toThrow(/stale/);
    expect(resumed.status).toBe("uncertain");
});

it("reconciles an ethers replacement hash only after independently checking the frozen payload", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    const call = await ready.exportTransaction();
    const hash = `0x${"88".repeat(32)}` as const;
    const replacement = `0x${"99".repeat(32)}` as const;
    const tracked = await ready.trackTransaction(hash);
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: replacement,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: replacement,
        status: "success",
        logs: [],
    });
    h.reader.isSpent = async (_, values) => values.map(() => true);
    const confirmed = await tracked.reconcile({ transactionHash: replacement });
    expect(confirmed.status).toBe("confirmed");
    expect((await h.store.readSnapshot(h.scope)).operations[ready.id]!.transactionHash).toBe(
        replacement
    );
});

it("checks protocol facts before export without taking responsibility for EVM fees or broadcasting", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    await expect(ready.trackTransaction("invalid hash")).rejects.toThrow(/hash/);
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(ready.exportTransaction()).rejects.toThrow(/spent/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
});

it("recovers a known unencrypted owned opening on confirmation without inventing opaque notes", async () => {
    const h = await fixture();
    const { NoteOutput } = await import("@invisi-labs/sdk/session-support");
    const owned = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "evm", address: h.wallet.ownerAddress, envelope: false },
    });
    const opaque = await NoteOutput.create({
        ...h.context,
        amount: 20n,
        recipient: { type: "identity", identity: owned.identity },
    });
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        })
    );
    const ready = await (
        await session.prepareShield({
            tokenAddress: h.context.tokenAddress,
            outputs: [owned, opaque],
            funding: { payer: signer.address, amount: 50n, authorization: "caller" },
        })
    ).ready();
    const call = await ready.exportTransaction();
    const hash = `0x${"ab".repeat(32)}` as Hex;
    await h.tree.insert(BigInt(owned.commitment));
    await h.tree.insert(BigInt(opaque.commitment));
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    const logs = [
        await receiptLog(
            "CommitmentsInserted",
            { treeId: 1n, startLeafIndex: 1, commitments: [owned.commitment, opaque.commitment] },
            0,
            hash
        ),
        await receiptLog(
            "Shield",
            {
                token: h.context.tokenAddress,
                treeId: 1n,
                startLeafIndex: 1,
                payer: signer.address,
                amount: 50n,
                deadline: (
                    (await h.store.readSnapshot(h.scope)).operations[ready.id]!
                        .payload as import("@invisi-labs/sdk/session-support").SavedOperation
                ).plan.deadline,
                deliveries: [owned.delivery, opaque.delivery],
            },
            1,
            hash
        ),
    ];
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs,
    });
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[owned.commitment]!.note).toEqual(owned.note);
    expect(state.notes[owned.commitment]!.leafIndex).toBe(1);
    expect(state.notes[opaque.commitment]).toBeUndefined();
});
