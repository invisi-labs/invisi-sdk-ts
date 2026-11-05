import {
    mergeReceiptRecords,
    reserveInputs,
    releaseInputs,
    walletBalance,
    type WalletStore,
    type WalletScope,
} from "../index";
const hash = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
/** The identical behavioral contract is run in Node SQLite and real browser IndexedDB. */
export async function runStoreContract(
    first: WalletStore,
    second: WalletStore,
    scope: WalletScope
): Promise<{ checks: number }> {
    const id = hash(1),
        record = {
            note: {
                chainId: scope.chainId,
                protocolAddress: BigInt(scope.protocolAddress),
                tokenAddress: 0x2222222222222222222222222222222222222222n,
                ownerAddress: scope.ownerAddress,
                amount: 100n,
                nonce: 1n,
            },
            commitment: id,
            treeId: 1n,
            leafIndex: 0,
            blockNumber: 12n,
            blockHash: hash(12),
            spent: "unspent" as const,
        };
    let checks = 0;
    try {
        await first.transaction(scope, (state) => {
            state.notes[id] = record;
            state.observedThrough = { number: 12n, hash: hash(12) };
            throw new Error("rollback");
        });
    } catch (error) {
        check((error as Error).message === "rollback", "wrong rollback error");
    }
    check(
        Object.keys((await second.readSnapshot(scope)).notes).length === 0,
        "partial note escaped rollback"
    );
    checks++;
    const batch = {
        notes: [record],
        credits: [],
        checkpoint: { number: 12n, hash: hash(12) },
    };
    await first.transaction(scope, (state) => {
        mergeReceiptRecords(state, batch);
        state.observedThrough = { ...batch.checkpoint };
    });
    await second.transaction(scope, (state) => mergeReceiptRecords(state, batch));
    check(
        Object.keys((await first.readSnapshot(scope)).notes).length === 1,
        "repeated receipt duplicated balance"
    );
    checks++;
    let conflict = false;
    try {
        await first.transaction(scope, (state) =>
            mergeReceiptRecords(state, {
                ...batch,
                notes: [{ ...record, commitment: hash(2) }],
                checkpoint: { number: 13n, hash: hash(13) },
            })
        );
    } catch {
        conflict = true;
    }
    check(
        conflict && (await second.readSnapshot(scope)).observedThrough!.number === 12n,
        "conflicting receipt advanced checkpoint"
    );
    checks++;
    const copy = await second.readSnapshot(scope);
    copy.notes[id]!.note.amount = 1n;
    check(
        (await first.readSnapshot(scope)).notes[id]!.note.amount === 100n,
        "snapshot aliases persisted state"
    );
    checks++;
    const results = await Promise.allSettled([
        reserveInputs(first, scope, "worker-a", [id]),
        reserveInputs(second, scope, "worker-b", [id]),
    ]);
    check(
        results.filter((result) => result.status === "fulfilled").length === 1,
        "overlapping reservations both succeeded"
    );
    checks++;
    const current = await second.readSnapshot(scope),
        winner = current.reservations[id]!;
    check(
        walletBalance(current, "0x2222222222222222222222222222222222222222").availableKnown ===
            0n &&
            walletBalance(current, "0x2222222222222222222222222222222222222222").reserved === 100n,
        "reserved input remained available"
    );
    checks++;
    await first.transaction(scope, (state) => {
        state.operations[winner]!.status = "uncertain";
    });
    let rejected = false;
    try {
        await releaseInputs(second, scope, winner);
    } catch {
        rejected = true;
    }
    check(
        rejected && (await first.readSnapshot(scope)).reservations[id] === winner,
        "uncertain input lock was released"
    );
    checks++;
    check(
        Object.keys(
            (await second.readSnapshot({ ...scope, namespace: scope.namespace + "-other" })).notes
        ).length === 0,
        "tenant data crossed scope"
    );
    checks++;
    check(
        (await second.readSnapshot(scope)).observedThrough!.number === 12n,
        "checkpoint lost or advanced without state"
    );
    checks++;
    await first.transaction(scope, (state) => {
        state.notes[id]!.spent = "unknown";
    });
    check(
        walletBalance(
            await second.readSnapshot(scope),
            "0x2222222222222222222222222222222222222222"
        ).availableKnown === null,
        "unknown spent state was declared available"
    );
    checks++;
    return { checks };
}
