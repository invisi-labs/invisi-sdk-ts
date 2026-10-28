import type { Hex } from "@invisi-labs/protocol/contracts";

import {
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditSharedKeyHash,
    recoverCreditRemainder,
    type CreditDeliveryState,
    type ReceivingKeys,
    type ViewingCapability,
} from "@invisi-labs/core";
import type { Protocol, ChainReader } from "@invisi-labs/protocol";
import type { DeliveryEventLog, DiscoveredCredit } from "./discovery";
import type { StoredCredit, WalletScope, WalletState, WalletStore } from "./state";

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
    viewing: Pick<ViewingCapability, "walletIdentity" | "decryptNote" | "decryptCredit">;
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
            await computeCreditCommitment(
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
            )
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
                const args = event.args!;
                const params = args.params as {
                    nullifiers: readonly Hex[];
                    remainderCommitments: readonly Hex[];
                    recoveryAmounts: readonly Hex[];
                    expiries: readonly bigint[];
                };
                const indices = args.remainderLeafIndices as readonly number[];
                check(
                    Array.isArray(params.nullifiers) &&
                        params.nullifiers.length === params.remainderCommitments.length &&
                        params.nullifiers.length === params.recoveryAmounts.length &&
                        params.nullifiers.length === params.expiries.length &&
                        params.nullifiers.length === indices.length,
                    "invalid draw recovery slots"
                );
                for (const [index, nullifier] of params.nullifiers.entries()) {
                    for (const previous of matching(nullifier)) {
                        check(
                            previous.state.note.expiry === params.expiries[index],
                            "draw recovery expiry mismatch"
                        );
                        const remainder = await recoverCreditRemainder(
                            context,
                            previous.state.note,
                            {
                                creditNullifier: nullifier,
                                remainderCommitment: params.remainderCommitments[index]!,
                                recoveryAmount: BigInt(params.recoveryAmounts[index]!),
                            }
                        );
                        if (!remainder) {
                            continue;
                        }
                        const record: StoredCredit = {
                            commitment: params.remainderCommitments[index]!,
                            treeId: BigInt(args.outputTreeId as bigint),
                            leafIndex: Number(indices[index]),
                            blockNumber: event.blockNumber!,
                            blockHash: event.blockHash!,
                            transactionHash: event.transactionHash!,
                            role: previous.role,
                            state: { ...clone(previous.state), note: remainder },
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
            } else if (event.eventName === "CreditToppedUp") {
                const params = event.args!.params as {
                    creditNullifier: Hex;
                    creation: { creditCommitment: Hex };
                };
                for (const previous of matching(params.creditNullifier)) {
                    const child = foundByKey.get(
                        params.creation.creditCommitment + ":" + previous.role
                    );
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
                            "spenderPayout",
                            "ownerPayout",
                            "creditSharedKey",
                        ].some(
                            (field) =>
                                old[field as keyof typeof old] !== next[field as keyof typeof next]
                        ) ||
                        next.amount <= old.amount ||
                        next.expiry < old.expiry
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
                        receivingKeySource: { kind: "top-up", commitment: previous.commitment },
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
