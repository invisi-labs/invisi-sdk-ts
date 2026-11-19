import type { Hex } from "@invisi-labs/primitives";
import { MAX_CIPHERTEXT_BYTES } from "@invisi-labs/primitives";
import { getAddress, isAddress } from "ethers";
import type { CanonicalReader } from "../queries/context";
import { invalid } from "../transport/errors";
import type {
    CanonicalBlock,
    ProtocolNoteOutput,
    IndexedCreditState,
    ProtocolUpdateRange,
} from "../types";
import { fieldHash, hash, integer, object, list } from "./values";

async function metadata(
    canonical: CanonicalReader,
    value: unknown,
    range: Pick<ProtocolUpdateRange, "fromBlock" | "toBlock">
) {
    const output = object(value),
        block = await canonical(output.block);
    if (block.number < range.fromBlock || block.number > range.toBlock)
        invalid("RPC output outside update range");
    const treeId = integer(output.treeId);
    if (treeId === 0n) invalid("Invalid output tree");
    if (typeof output.token !== "string" || !isAddress(output.token) || BigInt(output.token) === 0n)
        invalid("Invalid output token");
    if (typeof output.kind !== "string" || !output.kind) invalid("Invalid output kind");
    return {
        block,
        treeId,
        leafIndex: Number(integer(output.leafIndex, 16)),
        commitment: fieldHash(output.commitment),
        tokenAddress: getAddress(output.token as string) as `0x${string}`,
        transactionHash: hash(output.transactionHash),
        logIndex: Number(integer(output.logIndex, 32)),
        kind: output.kind as string,
    };
}
function delivery(value: unknown, allowOmitted: boolean) {
    const d = object(value);
    if (
        typeof d.ciphertext !== "string" ||
        !/^0x(?:[0-9a-f]{2})*$/i.test(d.ciphertext) ||
        (d.ciphertext.length - 2) / 2 > MAX_CIPHERTEXT_BYTES
    )
        invalid("Invalid output ciphertext");
    const omitted = d.ciphertext === "0x";
    if (
        (omitted && !allowOmitted) ||
        typeof d.clue !== "string" ||
        (omitted ? d.clue !== "0x" : !/^0x[0-9a-f]{136}$/i.test(d.clue))
    )
        invalid("Invalid output clue");
    return {
        ciphertext: (d.ciphertext as string).toLowerCase() as Hex,
        clue: (d.clue as string).toLowerCase() as Hex,
    };
}
function unique<T extends { treeId: bigint; leafIndex: number; commitment: Hex }>(
    values: T[]
): T[] {
    const positions = new Map<string, string>(),
        commitments = new Map<Hex, string>(),
        seen = new Set<string>(),
        out: T[] = [];
    for (const value of values) {
        const fingerprint = JSON.stringify(value, (_, v) =>
                typeof v === "bigint" ? v.toString() : v
            ),
            position = `${value.treeId}:${value.leafIndex}`;
        const a = positions.get(position),
            b = commitments.get(value.commitment);
        if ((a !== undefined && a !== fingerprint) || (b !== undefined && b !== fingerprint))
            invalid("Conflicting RPC output data or position");
        if (!seen.has(fingerprint)) out.push(value);
        seen.add(fingerprint);
        positions.set(position, fingerprint);
        commitments.set(value.commitment, fingerprint);
    }
    return out;
}
export async function parseNoteCandidates(
    canonical: CanonicalReader,
    block: CanonicalBlock,
    values: unknown[],
    range: Pick<ProtocolUpdateRange, "fromBlock" | "toBlock">
): Promise<{ block: CanonicalBlock; notes: ProtocolNoteOutput[] }> {
    const notes: ProtocolNoteOutput[] = [];
    for (const value of values) {
        const m = await metadata(canonical, value, range);
        if (!["NoteOutputs", "CreditDraw"].includes(m.kind))
            invalid("Credit state cannot appear in Note results");
        notes.push({ ...m, ...delivery(value, true) });
    }
    return { block, notes: unique(notes) };
}
export async function parseCreditCandidates(
    canonical: CanonicalReader,
    block: CanonicalBlock,
    values: unknown[],
    range: Pick<ProtocolUpdateRange, "fromBlock" | "toBlock">
): Promise<{ block: CanonicalBlock; states: IndexedCreditState[] }> {
    const states: IndexedCreditState[] = [];
    for (const value of values) {
        const raw = object(value),
            m = await metadata(canonical, value, range);
        if (
            !["CreditCreated", "CreditDraw", "CreditStateTransition", "CreditUpdated"].includes(
                m.kind
            )
        )
            invalid("Invalid Credit state event");
        const deliveries = list(raw.deliveries);
        if (deliveries.length !== 2) invalid("Credit state requires both role deliveries");
        states.push({
            ...m,
            kind: m.kind as IndexedCreditState["kind"],
            deliveries: deliveries.map((v) => delivery(v, false)),
        });
    }
    return { block, states: unique(states) };
}
