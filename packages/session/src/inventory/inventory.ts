import type { authenticatedDecryptor } from "@invisi-labs/primitives";
import type { Hex } from "@invisi-labs/protocol/contracts";

import {
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditSharedKeyHash,
    recoverCreditState,
    type CreditDeliveryState,
    type ReceivingKeys,
} from "@invisi-labs/primitives";
import type { ChainReader } from "@invisi-labs/protocol";
import type { Protocol } from "@invisi-labs/rpc";
import type { DeliveryEventLog, DiscoveredCredit } from "@invisi-labs/sdk/session-support";
import type { StoredCredit, WalletScope, WalletState, WalletStore } from "../storage/state";

export class CanonicalConflict extends Error {}

export class CreditMetadataMismatch extends Error {}

function check(value: unknown, message: string): asserts value {
    if (!value) {
        throw new Error(message);
    }
}

const clone = <T>(value: T): T => structuredClone(value);

const hex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;

export interface InventoryOptions {
    protocol: Protocol;
    scope: WalletScope;
    store: WalletStore;
    reader: ChainReader;
    viewing: ReturnType<typeof authenticatedDecryptor>;
    receivingKeys?: ReceivingKeys;
}

/** Authenticated private inventory handling for indexed candidate ingestion. */
export abstract class InventoryProcessor {
    readonly #options: InventoryOptions;

    constructor(options: InventoryOptions) {
        this.#options = { ...options, scope: Object.freeze({ ...options.scope }) };
    }

    protected reorgOperations(state: WalletState): void {
        for (const operation of Object.values(state.operations)) {
            if (
                ["failed", "expired"].includes(operation.status) &&
                !(operation.payload as { externalized?: boolean } | undefined)?.externalized
            ) {
                continue;
            }
            operation.status = "reorged";
            for (const id of operation.inputs) {
                if (!state.reservations[id]) {
                    state.reservations[id] = operation.id;
                }
            }
        }
    }

    protected async invalidate(): Promise<void> {
        const { store, scope } = this.#options;
        await store.transaction(scope, (state) => {
            state.invalidated = "Canonical history changed; rebuild inventory from canonical data";
            for (const record of [...Object.values(state.notes), ...Object.values(state.credits)]) {
                record.spent = "unknown";
            }
            this.reorgOperations(state);
        });
    }

    protected checkSnapshotKeys(record: DiscoveredCredit | StoredCredit): void {
        const expected = this.#options.receivingKeys;
        const keys =
            record.role === "owner"
                ? record.state.ownerReceivingKeys
                : record.state.spenderReceivingKeys;
        if (
            expected &&
            !keys.viewingPublicKey.every((byte, i) => byte === expected.viewingPublicKey[i])
        ) {
            throw new CreditMetadataMismatch("Credit receiving key snapshot mismatch");
        }
        const clue = expected?.clueKey;
        if (clue && !keys.clueKey.every((byte, i) => byte === clue[i])) {
            throw new CreditMetadataMismatch("Credit clue key snapshot mismatch");
        }
    }

    protected async creditNullifier(state: CreditDeliveryState): Promise<Hex> {
        const n = state.note;
        return computeCreditNullifier(
            n.chainId,
            n.creditSharedKey,
            await computeCreditCommitment(n)
        );
    }

    protected async recoverCredits(
        base: WalletState,
        found: readonly StoredCredit[],
        logs: readonly DeliveryEventLog[],
        snapshot: { getLeaf(treeId: bigint, leafIndex: number): bigint | Promise<bigint> }
    ): Promise<StoredCredit[]> {
        const known = new Map<string, StoredCredit>();
        const byNullifier = new Map<Hex, Set<string>>();
        const cachedNullifiers = new Map<Hex, Hex>();
        const recovered: StoredCredit[] = [];
        const foundByKey = new Map(
            found.map((record) => [record.commitment + ":" + record.role, record])
        );
        const remember = async (record: StoredCredit) => {
            const key = record.commitment + ":" + record.role;
            let nullifier = cachedNullifiers.get(record.commitment);
            if (!nullifier) {
                nullifier = await this.creditNullifier(record.state);
                cachedNullifiers.set(record.commitment, nullifier);
            }
            known.set(key, record);
            let members = byNullifier.get(nullifier);
            if (!members) {
                members = new Set();
                byNullifier.set(nullifier, members);
            }
            members.add(key);
        };
        const matching = (nullifier: Hex) =>
            [...(byNullifier.get(nullifier) ?? [])].map((key) => known.get(key)!);
        for (const record of Object.values(base.credits)) {
            await remember(record);
        }
        for (const record of found) {
            try {
                this.checkSnapshotKeys(record);
                await remember({ ...record, spent: "unknown" });
            } catch (error) {
                if (!(error instanceof CreditMetadataMismatch)) {
                    throw error;
                }
            }
        }
        const context = {
            chainId: this.#options.scope.chainId,
            protocolAddress: BigInt(this.#options.scope.protocolAddress),
        };
        for (const event of logs) {
            if (event.eventName === "CreditDraw") {
                const block = await this.#options.reader.getBlock(event.blockNumber!);
                if (block.hash !== event.blockHash)
                    throw new CanonicalConflict("draw block changed during Credit recovery");
                const args = event.args!;
                const params = args.params as {
                    nullifiers: readonly Hex[];
                    creditCommitments: readonly Hex[];
                    recoveryAmounts: readonly Hex[];
                };
                const indices = args.leafIndices as readonly number[];
                check(
                    Array.isArray(params.nullifiers) &&
                        params.nullifiers.length === params.creditCommitments.length &&
                        params.nullifiers.length === params.recoveryAmounts.length &&
                        params.nullifiers.length + 1 === indices.length,
                    "invalid draw recovery slots"
                );
                for (const [index, nullifier] of params.nullifiers.entries()) {
                    for (const previous of matching(nullifier)) {
                        const successor = await recoverCreditState(context, previous.state.note, {
                            timestamp: block.timestamp,
                            creditNullifier: nullifier,
                            stateCommitment: params.creditCommitments[index]!,
                            recoveryAmount: BigInt(params.recoveryAmounts[index]!),
                        });
                        // Financial recovery alone cannot establish uncommitted child metadata.
                        const child = foundByKey.get(
                            params.creditCommitments[index]! + ":" + previous.role
                        );
                        const payload = child?.state.note.payload;
                        const record: StoredCredit = {
                            commitment: params.creditCommitments[index]!,
                            treeId: BigInt(args.outputTreeId as bigint),
                            leafIndex: Number(indices[index]),
                            blockNumber: event.blockNumber!,
                            blockHash: event.blockHash!,
                            transactionHash: event.transactionHash!,
                            role: previous.role,
                            state: {
                                ...clone(previous.state),
                                note: {
                                    ...successor,
                                    ...(payload === undefined ? {} : { payload: clone(payload) }),
                                },
                            },
                            receivingKeySource: { kind: "draw", commitment: previous.commitment },
                            spent: "unknown",
                        };
                        check(
                            (await snapshot.getLeaf(record.treeId, record.leafIndex)) ===
                                BigInt(record.commitment),
                            "draw recovery canonical leaf mismatch"
                        );
                        this.checkSnapshotKeys(record);
                        await remember(record);
                        recovered.push(record);
                    }
                }
            } else if (event.eventName === "CreditUpdated") {
                const params = event.args!.params as {
                    nullifier: Hex;
                    creditCommitment: Hex;
                };
                for (const previous of matching(params.nullifier)) {
                    const child = foundByKey.get(params.creditCommitment + ":" + previous.role);
                    if (!child) {
                        continue;
                    }
                    const old = previous.state.note;
                    const next = child.state.note;
                    if (
                        [
                            "chainId",
                            "protocolAddress",
                            "tokenAddress",
                            "spenderWalletIdentity",
                            "ownerWalletIdentity",
                            "revocationShard",
                            "revocationSlot",
                            "creditSharedKey",
                        ].some(
                            (field) =>
                                old[field as keyof typeof old] !== next[field as keyof typeof next]
                        ) ||
                        ["lastDay", "dailySpent", "lastMonth", "monthlySpent", "totalSpent"].some(
                            (field) =>
                                old[field as keyof typeof old] !== next[field as keyof typeof next]
                        )
                    ) {
                        continue;
                    }
                    const repaired: StoredCredit = {
                        ...clone(child),
                        state: {
                            note: clone(next),
                            ownerReceivingKeys: clone(previous.state.ownerReceivingKeys),
                            spenderReceivingKeys: clone(previous.state.spenderReceivingKeys),
                        },
                        receivingKeySource: { kind: "update", commitment: previous.commitment },
                    };
                    this.checkSnapshotKeys(repaired);
                    await remember(repaired);
                    recovered.push(repaired);
                }
            }
        }
        return recovered;
    }
}
