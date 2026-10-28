import type { Hex } from "@invisi-labs/protocol/contracts";
import { readProtocolLogs } from "./receipt-logs";

import { computeCreditNullifier } from "@invisi-labs/core";
import type { CanonicalBlock, CanonicalReceipt } from "@invisi-labs/protocol";
import { matchesAggregateTransaction } from "./aggregate-receipt";
import { creditLeaf } from "./credit-values";
import { extractDeliveryCandidates } from "./discovery";
import { verifyMembership } from "./membership";
import { inputFacts, operationExpired } from "./operation-protocol";
import type { OperationRuntime, SavedOperation } from "./operation-types";
import { mergeReceiptRecords, mergeSpentObservation } from "./receipts";
import type { OperationStatus, StoredCredit, StoredNote, WalletState } from "./state";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}

async function barrier(
    runtime: OperationRuntime,
    state: WalletState,
    block?: CanonicalBlock
): Promise<void> {
    const checkpoints = [
        state.observedThrough,
        ...(block ? [{ number: block.number, hash: block.hash }] : []),
    ];
    for (const point of checkpoints) {
        if (point && (await runtime.reader.getBlock(point.number)).hash !== point.hash) {
            await runtime.store.transaction(runtime.scope, (draft) => {
                draft.invalidated = "Canonical operation checkpoint changed; full resync required";
                for (const record of [
                    ...Object.values(draft.notes),
                    ...Object.values(draft.credits),
                ]) {
                    record.spent = "unknown";
                }
                for (const operation of Object.values(draft.operations)) {
                    if (
                        ["failed", "expired"].includes(operation.status) &&
                        !(operation.payload as { externalized?: boolean } | undefined)?.externalized
                    ) {
                        continue;
                    }
                    operation.status = "reorged";
                    for (const id of operation.inputs) {
                        if (!draft.reservations[id]) {
                            draft.reservations[id] = operation.id;
                        }
                    }
                }
            });
            throw new Error("canonical operation checkpoint changed; full resync required");
        }
    }
}

function current(state: WalletState, id: string, generation: number) {
    check(!state.invalidated, "wallet requires canonical resync");
    const record = state.operations[id];
    const saved = record?.payload as SavedOperation;
    check(record && saved.generation === generation && !saved.claim, "stale operation recovery");
    return { record, saved };
}

function observe(state: WalletState, block: CanonicalBlock): void {
    if (state.observedThrough?.number === block.number) {
        check(state.observedThrough.hash === block.hash, "operation checkpoint conflict");
    }
    if (!state.observedThrough || state.observedThrough.number < block.number) {
        state.observedThrough = { number: block.number, hash: block.hash };
    }
}

export async function confirmOperation(
    runtime: OperationRuntime,
    id: string,
    generation: number,
    hash: Hex,
    signal?: AbortSignal
): Promise<{ status: OperationStatus; saved: SavedOperation } | undefined> {
    const { reader, store, scope, options } = runtime;
    const state = await store.readSnapshot(scope);
    const { saved } = current(state, id, generation);
    const plan = saved.plan;
    await options.protocol.validateDeployment(reader);
    await barrier(runtime, state);
    const receipt = await reader.getReceipt(hash);
    if (!receipt) {
        return undefined;
    }
    check(receipt.transactionHash === hash, "receipt transaction identity mismatch");
    await barrier(runtime, state, receipt.block);
    const transaction = await reader.getTransaction(hash);
    check(
        transaction && transaction.transactionHash === hash,
        "confirmed transaction differs from the frozen operation"
    );

    let matchesRequest: boolean;
    if (plan.statement?.target === "noir-recursive") {
        matchesRequest = matchesAggregateTransaction(saved, transaction);
    } else {
        matchesRequest =
            !!saved.call &&
            transaction.to.toLowerCase() === saved.call.to.toLowerCase() &&
            transaction.value === saved.call.value &&
            transaction.data.toLowerCase() === saved.call.data.toLowerCase();
    }
    check(matchesRequest, "confirmed transaction differs from the frozen operation");

    check(
        receipt.status === "success" || receipt.status === "reverted",
        "receipt execution status is missing"
    );
    // A reverted transaction does not revoke its public authorization.
    if (receipt.status === "reverted") {
        return undefined;
    }
    const candidates = extractDeliveryCandidates(
        readProtocolLogs(receipt, plan.context.protocolAddress),
        plan.context,
        receipt.block.number
    );
    const latest = await reader.getLatestBlockNumber();
    const height = [latest, receipt.block.number, state.observedThrough?.number ?? 0n].reduce(
        (a, b) => (a > b ? a : b)
    );
    const spentBlock = await reader.getBlock(height);
    check(spentBlock.number === height, "spent-state canonical block mismatch");
    const notes: StoredNote[] = [];
    for (const output of plan.outputs) {
        const candidate = candidates.find(
            (value) => value.role === "funds" && value.commitment === output.commitment
        );
        check(candidate, "confirmed output is missing from canonical receipt");
        if (output.note.walletIdentity !== scope.walletIdentity) {
            continue;
        }
        const input = {
            treeId: candidate.treeId,
            leafIndex: candidate.leafIndex,
            commitment: candidate.commitment,
        };
        check(options.protocolRpc, "membership provider required for confirmed owned output");
        const proof = await options.protocolRpc!.getMembership(plan.context, input, receipt.block);
        await verifyMembership(reader, plan.context, receipt.block, input, proof);
        notes.push({
            ...input,
            note: structuredClone(output.note),
            blockNumber: receipt.block.number,
            blockHash: receipt.block.hash,
            transactionHash: hash,
            spent: "unknown",
        });
    }
    const credits: StoredCredit[] = [];
    for (const output of plan.credit?.outputs ?? []) {
        const n = output.state.note;
        for (const role of ["owner", "spender"] as const) {
            if (
                (role === "owner" ? n.ownerWalletIdentity : n.spenderWalletIdentity) !==
                scope.walletIdentity
            ) {
                continue;
            }
            const candidate = candidates.find(
                (value) => value.role === role && value.commitment === output.commitment
            );
            check(candidate, "confirmed Credit output is missing from canonical receipt");
            const input = {
                treeId: candidate.treeId,
                leafIndex: candidate.leafIndex,
                commitment: candidate.commitment,
            };
            check(options.protocolRpc, "membership provider required for confirmed Credit");
            const proof = await options.protocolRpc!.getMembership(
                plan.context,
                input,
                receipt.block
            );
            await verifyMembership(reader, plan.context, receipt.block, input, proof);
            const index = plan.credit?.draw?.remainderCommitments.indexOf(output.commitment);
            const parent = plan.credit?.topUp
                ? plan.credit.inputs[0]
                : index !== undefined && index >= 0
                  ? plan.credit?.inputs[index]
                  : undefined;
            const receivingKeySource =
                parent && state.credits[parent.commitment + ":" + role]
                    ? {
                          kind: plan.credit?.topUp ? ("top-up" as const) : ("draw" as const),
                          commitment: parent.commitment,
                      }
                    : undefined;
            credits.push({
                ...input,
                state: structuredClone(output.state),
                role,
                blockNumber: receipt.block.number,
                blockHash: receipt.block.hash,
                transactionHash: hash,
                spent: "unknown",
                ...(receivingKeySource ? { receivingKeySource } : {}),
            });
        }
    }
    if (credits.length) {
        const nullifiers = await Promise.all(
            credits.map(async (record) =>
                computeCreditNullifier(
                    plan.context.chainId,
                    record.state.note.creditSharedKey,
                    await creditLeaf(record.state)
                )
            )
        );
        const values = await reader.isSpent(plan.context, nullifiers, spentBlock);
        check(
            values.length === credits.length && values.every((value) => typeof value === "boolean"),
            "invalid Credit spent-state response"
        );
        credits.forEach((record, i) => {
            record.spent = values[i] ? "spent" : "unspent";
            record.checkedThrough = { number: spentBlock.number, hash: spentBlock.hash };
        });
    }
    const facts = inputFacts(plan);
    const nfs = facts.map((input) => input.nullifier);
    const spent = nfs.length ? await reader.isSpent(plan.context, nfs, spentBlock) : [];
    check(
        spent.length === nfs.length && spent.every((value) => value === true),
        "successful operation inputs are not consumed"
    );
    // Complete recovered note openings determine their consumption markers without signing authority.
    const nullifier = options.wallet.exportNullifier();
    if (notes.length) {
        const values = await reader.isSpent(
            plan.context,
            await Promise.all(
                notes.map((note) =>
                    nullifier!.compute(plan.context.chainId, note.commitment, note.note.nonce)
                )
            ),
            spentBlock
        );
        check(
            values.length === notes.length && values.every((value) => typeof value === "boolean"),
            "invalid output spent-state response"
        );
        notes.forEach((note, i) => {
            note.spent = values[i] ? "spent" : "unspent";
            note.checkedThrough = { number: spentBlock.number, hash: spentBlock.hash };
        });
    }
    signal?.throwIfAborted();
    await barrier(runtime, state, receipt.block);
    await barrier(runtime, state, spentBlock);
    return store.transaction(scope, (draft) => {
        signal?.throwIfAborted();
        const { record, saved: active } = current(draft, id, generation);
        for (const point of [draft.observedThrough]) {
            check(
                !point ||
                    point.number < spentBlock.number ||
                    (point.number === spentBlock.number && point.hash === spentBlock.hash),
                "wallet advanced or changed during confirmation; retry"
            );
        }
        mergeReceiptRecords(draft, {
            notes,
            credits,
            checkpoint: { number: receipt.block.number, hash: receipt.block.hash },
        });
        for (const fact of facts) {
            const input = draft[fact.kind][fact.key];
            if (input) {
                mergeSpentObservation(input, {
                    spent: "spent",
                    checkedThrough: { number: spentBlock.number, hash: spentBlock.hash },
                });
            }
            if (fact.kind === "credits" && input) {
                for (const other of Object.values(draft.credits)) {
                    if (other.commitment === input.commitment) {
                        mergeSpentObservation(other, {
                            spent: "spent",
                            checkedThrough: { number: spentBlock.number, hash: spentBlock.hash },
                        });
                    }
                }
            }
            if (draft.reservations[fact.reservationKey] === id) {
                delete draft.reservations[fact.reservationKey];
            }
        }
        observe(draft, spentBlock);
        record.status = "confirmed";
        record.transactionHash = hash;
        active.generation++;
        return { status: record.status, saved: structuredClone(active) };
    });
}

export async function reconcileOperation(
    runtime: OperationRuntime,
    id: string,
    generation: number,
    signal?: AbortSignal
): Promise<{ status: OperationStatus; saved: SavedOperation }> {
    const { reader, store, scope, options } = runtime;
    const state = await store.readSnapshot(scope);
    const { record, saved } = current(state, id, generation);
    const plan = saved.plan;
    await options.protocol.validateDeployment(reader);
    await barrier(runtime, state);
    const block = await reader.getBlock(await reader.getLatestBlockNumber());
    const facts = inputFacts(plan);
    const nfs = facts.map((input) => input.nullifier);
    const spent = nfs.length ? await reader.isSpent(plan.context, nfs, block) : [];
    check(
        spent.length === nfs.length && spent.every((value) => typeof value === "boolean"),
        "invalid reconciliation spent-state response"
    );
    const expired = operationExpired(plan, block.timestamp);
    // Funding grants can be renewed and an unknown root can reappear. Neither revokes the wallet proof.
    const impossible = spent.some((value) => value);
    signal?.throwIfAborted();
    await barrier(runtime, state, block);
    return store.transaction(scope, (draft) => {
        signal?.throwIfAborted();
        const { record: active, saved: next } = current(draft, id, generation);
        for (const point of [
            draft.observedThrough,
            ...facts.map((fact) => draft[fact.kind][fact.key]?.checkedThrough),
        ]) {
            check(
                !point ||
                    point.number < block.number ||
                    (point.number === block.number && point.hash === block.hash),
                "wallet advanced or changed during reconciliation; retry"
            );
        }
        if (expired || impossible) {
            active.status = expired ? "expired" : "failed";
            facts.forEach((fact, i) => {
                const input = draft[fact.kind][fact.key];
                if (input) {
                    mergeSpentObservation(input, {
                        spent: spent[i] ? "spent" : "unspent",
                        checkedThrough: { number: block.number, hash: block.hash },
                    });
                    if (fact.kind === "credits") {
                        for (const other of Object.values(draft.credits)) {
                            if (other.commitment === input.commitment) {
                                mergeSpentObservation(other, {
                                    spent: spent[i] ? "spent" : "unspent",
                                    checkedThrough: { number: block.number, hash: block.hash },
                                });
                            }
                        }
                    }
                }
                if (draft.reservations[fact.reservationKey] === id) {
                    delete draft.reservations[fact.reservationKey];
                }
            });
            observe(draft, block);
        } else if (next.externalized || active.status === "reorged") {
            active.status = "uncertain";
        }
        next.generation++;
        return { status: active.status, saved: structuredClone(next) };
    });
}
