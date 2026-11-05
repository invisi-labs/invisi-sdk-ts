import type { NoteRecord } from "../records";
/** Minimal input count by descending amount, with deterministic tree/position/commitment ties. */
export type SelectableNote = Pick<
    NoteRecord,
    "note" | "commitment" | "treeId" | "leafIndex" | "spent"
>;
export function selectNotes<T extends SelectableNote>(
    notes: readonly T[],
    target: bigint,
    reserved: ReadonlySet<string>
): T[] {
    if (typeof target !== "bigint" || target < 0n)
        throw new Error("selection target must be a nonnegative amount");
    if (target === 0n) return [];
    const eligible = notes.filter(
        (note) => note.spent === "unspent" && !reserved.has(note.commitment)
    );
    for (const record of eligible)
        if (
            typeof record.note.amount !== "bigint" ||
            record.note.amount <= 0n ||
            record.note.amount >= 1n << 128n
        )
            throw new Error("invalid verified note amount");
    eligible.sort((a, b) =>
        a.note.amount > b.note.amount
            ? -1
            : a.note.amount < b.note.amount
              ? 1
              : a.treeId < b.treeId
                ? -1
                : a.treeId > b.treeId
                  ? 1
                  : a.leafIndex - b.leafIndex || a.commitment.localeCompare(b.commitment)
    );
    const selected: T[] = [];
    let total = 0n;
    for (const record of eligible) {
        selected.push(structuredClone(record));
        total += record.note.amount;
        if (total >= target) return selected;
    }
    throw new Error("insufficient verified available funds");
}
