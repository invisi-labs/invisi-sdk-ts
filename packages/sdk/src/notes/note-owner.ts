import type { Note } from "@invisi-labs/primitives";

/** Note openings carry an address value, without a receiving-address text checksum. */
export function noteOwnerAddress(value: Note["ownerAddress"]): Note["ownerAddress"] {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
        throw new Error("invalid note owner address encoding");
    if (BigInt(value) === 0n) throw new RangeError("note owner address must be nonzero");
    return value.toLowerCase() as Note["ownerAddress"];
}

/** Copy an opening at the transaction boundary; never rewrite caller or stored records. */
export function normalizeNoteOwner(note: Note): Note {
    return { ...note, ownerAddress: noteOwnerAddress(note.ownerAddress) };
}
