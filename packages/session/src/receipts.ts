import type { Checkpoint, StoredCredit, StoredNote, WalletState } from "./state";

export interface ReceiptRecords {
    notes: readonly StoredNote[];
    credits: readonly StoredCredit[];
    checkpoint: Checkpoint;
}

function canonical(value: unknown): string {
    return JSON.stringify(value, (_, item) => {
        if (typeof item === "bigint") {
            return ["bigint", item.toString()];
        }
        if (item instanceof Uint8Array) {
            return Array.from(item);
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, item[key]])
            );
        }
        return item;
    });
}

function validateInheritance(state: WalletState, record: StoredCredit): boolean {
    const source = record.receivingKeySource;
    if (!source) return false;

    const parent = state.credits[source.commitment + ":" + record.role];
    if (!parent) {
        throw new Error("Credit receiving inheritance has no authenticated parent");
    }

    const previous = parent.state;
    const successor = record.state;
    const immutableFields = [
        "chainId",
        "protocolAddress",
        "tokenAddress",
        "spenderWalletIdentity",
        "ownerWalletIdentity",
        "spenderPayout",
        "ownerPayout",
        "creditSharedKey",
    ] as const;
    if (
        immutableFields.some((field) => previous.note[field] !== successor.note[field]) ||
        canonical(previous.ownerReceivingKeys) !== canonical(successor.ownerReceivingKeys) ||
        canonical(previous.spenderReceivingKeys) !== canonical(successor.spenderReceivingKeys)
    ) {
        throw new Error("Credit receiving inheritance changed immutable fields");
    }

    if (source.kind === "draw") {
        if (
            successor.note.amount >= previous.note.amount ||
            successor.note.expiry !== previous.note.expiry
        ) {
            throw new Error("invalid Credit receiving inheritance");
        }
    } else if (
        source.kind !== "top-up" ||
        successor.note.amount <= previous.note.amount ||
        successor.note.expiry < previous.note.expiry
    ) {
        throw new Error("invalid Credit receiving inheritance");
    }
    return true;
}

/** Merge canonical spent observations without replacing a newer per-input checkpoint. */
export function mergeSpentObservation(
    previous: Pick<StoredNote, "spent" | "checkedThrough">,
    incoming: Pick<StoredNote, "spent" | "checkedThrough">
): void {
    const next = incoming.checkedThrough;
    const old = previous.checkedThrough;
    if (!next || incoming.spent === "unknown") {
        return;
    }
    if (old && next.number < old.number) {
        return;
    }
    if (old && next.number === old.number && next.hash !== old.hash) {
        throw new Error("canonical spent checkpoint conflict requires resync");
    }
    if (previous.spent === "spent" && incoming.spent !== "spent") {
        throw new Error("canonical spent observation conflict requires resync");
    }
    previous.spent = incoming.spent;
    previous.checkedThrough = { ...next };
}

/** Atomic private inventory update; the caller must authenticate membership and block identity first. */
export function mergeReceiptRecords(state: WalletState, batch: ReceiptRecords): void {
    if (state.invalidated) {
        throw new Error("wallet inventory is invalidated");
    }
    const checkpoint = { ...batch.checkpoint };
    for (const record of [...batch.notes, ...batch.credits]) {
        if (record.blockNumber > checkpoint.number) {
            throw new Error("receipt exceeds confirmed checkpoint");
        }
        const atPosition = [...Object.values(state.notes), ...Object.values(state.credits)].filter(
            (existing) =>
                existing.treeId === record.treeId && existing.leafIndex === record.leafIndex
        );
        if (
            atPosition.some(
                (existing) =>
                    existing.commitment !== record.commitment ||
                    existing.blockHash !== record.blockHash
            )
        ) {
            throw new Error("canonical position conflict requires resync");
        }
        if ("note" in record) {
            const previous = state.notes[record.commitment];
            if (previous) {
                if (canonical(previous.note) !== canonical(record.note)) {
                    throw new Error("canonical note preimage conflict");
                }
                mergeSpentObservation(previous, record);
                continue;
            }
            state.notes[record.commitment] = record;
        } else {
            const key = record.commitment + ":" + record.role;
            const previous = state.credits[key];
            const inherited = validateInheritance(state, record);
            if (previous) {
                if (canonical(previous.state.note) !== canonical(record.state.note)) {
                    throw new Error("canonical Credit preimage conflict");
                }
                if (canonical(previous.state) !== canonical(record.state)) {
                    if (!inherited) {
                        if (previous.receivingKeySource) {
                            mergeSpentObservation(previous, record);
                            continue;
                        }
                        throw new Error("Credit receiving metadata conflict");
                    }
                    previous.state = record.state;
                    previous.receivingKeySource = record.receivingKeySource!;
                } else if (inherited) {
                    previous.receivingKeySource = record.receivingKeySource!;
                }
                mergeSpentObservation(previous, record);
                continue;
            }
            state.credits[key] = record;
        }
    }
}
