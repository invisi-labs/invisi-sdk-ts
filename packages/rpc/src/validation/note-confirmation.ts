import { poseidonHash, TREE_DEPTH, type Hex } from "@invisi-labs/primitives";
import { defineDeployment, type ProtocolDeployment } from "../deployment/deployment";
import type { CanonicalBlock, ProtocolNoteOutput } from "../types";
import { invalid } from "../transport/errors";
import { blockReference, fieldHash, integer, object } from "./values";
import { parseNoteCandidates } from "./outputs";

export type TrustedNoteFinality = "safe" | "finalized";
export type TrustedNotePendingReason =
    | "not_observed"
    | "pending_index"
    | "confirmation_pending"
    | "finality_unsupported"
    | "finality_unavailable"
    | "finality_inconsistent";
/** Locally checked proof; canonicality and receipt authentication are trusted RPC claims. */
export interface TrustedNoteMembership {
    anchor: { treeId: bigint; leafCount: bigint; root: Hex; block: CanonicalBlock };
    leafIndex: number;
    commitment: Hex;
    siblings: readonly Hex[];
}
interface TrustedNoteEnvelope {
    apiVersion: "v1";
    protocolVersion: "1";
    deployment: Readonly<ProtocolDeployment>;
    indexedHead: CanonicalBlock | null;
}
export type TrustedNoteLookup = TrustedNoteEnvelope &
    (
        | {
              status: "pending";
              reason: TrustedNotePendingReason;
              output: null;
              membership: null;
              confirmation: null;
          }
        | {
              status: "confirmed";
              reason: null;
              output: ProtocolNoteOutput;
              membership: TrustedNoteMembership;
              confirmation: {
                  finality: TrustedNoteFinality;
                  verifiedAt: CanonicalBlock;
                  finalityHead: CanonicalBlock;
              };
          }
    );
export async function parseTrustedNote(
    value: unknown,
    deployment: Readonly<ProtocolDeployment>,
    commitment: Hex,
    finality: TrustedNoteFinality
): Promise<TrustedNoteLookup> {
    const r = object(value);
    if (r.apiVersion !== "v1" || r.protocolVersion !== "1") invalid("Unsupported RPC note version");
    let claimed: Readonly<ProtocolDeployment>;
    try {
        claimed = defineDeployment(r.deployment);
    } catch {
        return invalid("Invalid RPC deployment");
    }
    const snapshot = (v: unknown) =>
        JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    if (snapshot(claimed) !== snapshot(deployment)) invalid("RPC deployment pins mismatch");
    const blocks: CanonicalBlock[] = [];
    const parseBlock = (v: unknown) => {
        const b = blockReference(v);
        if (
            BigInt(b.hash) === 0n ||
            b.number > BigInt(Number.MAX_SAFE_INTEGER) ||
            b.timestamp > BigInt(Number.MAX_SAFE_INTEGER)
        )
            invalid("Invalid trusted RPC block bounds or hash");
        for (const a of blocks) {
            if (a.hash === b.hash && a.number !== b.number)
                invalid("RPC block hash reused across heights");
            if (
                a.number === b.number &&
                (a.hash !== b.hash || a.parentHash !== b.parentHash || a.timestamp !== b.timestamp)
            )
                invalid("Inconsistent RPC block binding");
            const [older, newer] = a.number < b.number ? [a, b] : [b, a];
            if (older.number < newer.number && older.timestamp > newer.timestamp)
                invalid("Inconsistent RPC block time");
            if (older.number + 1n === newer.number && older.hash !== newer.parentHash)
                invalid("Inconsistent RPC parent hash");
        }
        blocks.push(b);
        return b;
    };
    const indexedHead = r.indexedHead === null ? null : parseBlock(r.indexedHead);
    const base: TrustedNoteEnvelope = {
        apiVersion: "v1",
        protocolVersion: "1",
        deployment: claimed,
        indexedHead,
    };
    if (r.status === "pending") {
        if (
            ![
                "not_observed",
                "pending_index",
                "confirmation_pending",
                "finality_unsupported",
                "finality_unavailable",
                "finality_inconsistent",
            ].includes(r.reason as string) ||
            r.output !== null ||
            r.membership !== null ||
            r.confirmation !== null
        )
            invalid("Invalid pending RPC note envelope");
        return {
            ...base,
            status: "pending",
            reason: r.reason as TrustedNotePendingReason,
            output: null,
            membership: null,
            confirmation: null,
        };
    }
    if (r.status !== "confirmed" || r.reason !== null || !indexedHead)
        return invalid("Invalid confirmed RPC note envelope");
    const c = object(r.confirmation);
    if (c.finality !== finality) invalid("RPC note finality mismatch");
    const verifiedAt = parseBlock(c.verifiedAt),
        finalityHead = parseBlock(c.finalityHead);
    if (
        verifiedAt.number !==
            (indexedHead.number < finalityHead.number ? indexedHead.number : finalityHead.number) ||
        verifiedAt.number < deployment.protocol.fromBlock
    )
        invalid("Invalid RPC confirmation coverage");
    const { notes } = await parseNoteCandidates(
        async (v) => parseBlock(v),
        verifiedAt,
        [r.output],
        { fromBlock: deployment.protocol.fromBlock, toBlock: verifiedAt.number }
    );
    const output = notes[0]!;
    if (BigInt(output.transactionHash) === 0n) invalid("Invalid RPC note transaction hash");
    if (output.treeId > BigInt(Number.MAX_SAFE_INTEGER))
        invalid("Invalid trusted RPC output tree bounds");
    const m = object(r.membership),
        a = object(m.anchor);
    const anchor = {
        treeId: integer(a.treeId),
        leafCount: integer(a.leafCount, 32),
        root: fieldHash(a.root),
        block: parseBlock(a.block),
    };
    if (anchor.treeId > BigInt(Number.MAX_SAFE_INTEGER))
        invalid("Invalid trusted RPC anchor tree bounds");
    const leafIndex = Number(integer(m.leafIndex, 16));
    if (
        output.commitment !== commitment ||
        fieldHash(m.commitment) !== commitment ||
        anchor.treeId !== output.treeId ||
        leafIndex !== output.leafIndex ||
        anchor.leafCount <= BigInt(leafIndex) ||
        anchor.leafCount > 1n << BigInt(TREE_DEPTH) ||
        anchor.block.number < output.block.number ||
        anchor.block.number > verifiedAt.number
    )
        invalid("Invalid RPC note membership binding");
    if (!Array.isArray(m.siblings) || m.siblings.length !== TREE_DEPTH)
        return invalid("Invalid RPC note proof depth");
    const siblings = m.siblings.map(fieldHash);
    let root = commitment;
    for (let i = 0; i < siblings.length; i++)
        root = await poseidonHash(
            (leafIndex >> i) & 1
                ? [BigInt(siblings[i]!), BigInt(root)]
                : [BigInt(root), BigInt(siblings[i]!)]
        );
    if (root !== anchor.root) invalid("Invalid RPC note proof root");
    return {
        ...base,
        status: "confirmed",
        reason: null,
        output,
        membership: { anchor, leafIndex, commitment, siblings },
        confirmation: { finality, verifiedAt, finalityHead },
    };
}
