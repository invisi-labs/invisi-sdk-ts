import { MAX_CIPHERTEXT_BYTES } from "@invisi-labs/core";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import { isAddress } from "ethers";

import {
    decodeAddress,
    ReceivingAddress,
    type CreditDeliveryState,
    type Note,
    type ViewingCapability,
} from "@invisi-labs/core";
import { normalizeOpaqueDelivery } from "@invisi-labs/protocol";

export interface DiscoveryContext {
    chainId: bigint;
    protocolAddress: Address;
}
/** Decoded logs from complete canonical transaction receipts, including insertion logs. */
export interface DeliveryEventLog {
    address: string;
    eventName: string;
    args?: Record<string, unknown>;
    blockNumber?: bigint | null;
    blockHash?: Hex | null;
    transactionHash?: Hex | null;
    logIndex?: number | null;
    removed?: boolean;
}
export interface DeliveryCandidate {
    tokenAddress: Address;
    treeId: bigint;
    leafIndex: number;
    commitment: Hex;
    role: "funds" | "owner" | "spender";
    delivery: { ciphertext: Hex; clue: Hex };
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
}
const EVENTS = new Set([
    "CommitmentsInserted",
    "BatchOutputs",
    "Shield",
    "Transact",
    "CrossTreeTransact",
    "CreditCreated",
    "CreditDraw",
    "CreditToppedUp",
    "CreditCancelled",
]);
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
    check(value && typeof value === "object" && !Array.isArray(value), "invalid event object");
    return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
    check(Array.isArray(value), "invalid event array");
    check(
        Array.from({ length: value.length }, (_, i) => i in value).every(Boolean),
        "sparse event array"
    );
    return value;
}
function integer(value: unknown): bigint {
    check(
        typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)),
        "invalid event integer"
    );
    const n = BigInt(value);
    check(n >= 0n, "negative event integer");
    return n;
}
function index(value: unknown): number {
    const n = integer(value);
    check(n < 65536n, "invalid event leaf index");
    return Number(n);
}
function hash(value: unknown): Hex {
    check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), "invalid event hash");
    return value.toLowerCase() as Hex;
}
function contextCheck(context: DiscoveryContext): void {
    check(context.chainId >= 0n && context.chainId < 1n << 64n, "invalid discovery chain");
    check(
        isAddress(context.protocolAddress) && BigInt(context.protocolAddress) !== 0n,
        "invalid discovery instance/token"
    );
}
const position = (tree: bigint, at: number) => `${tree}:${at}`;

/** Correlate deliveries with canonical insertion events, never service-supplied balances or positions.
 * The caller selects a confirmed chain/deployment and supplies complete decoded receipts.
 */
export function extractDeliveryCandidates(
    logs: readonly DeliveryEventLog[],
    context: DiscoveryContext,
    confirmedThrough: bigint
): DeliveryCandidate[] {
    contextCheck(context);
    check(confirmedThrough >= 0n, "invalid confirmed height");
    const relevant = logs.filter(
        (log) =>
            log.address.toLowerCase() === context.protocolAddress.toLowerCase() &&
            EVENTS.has(log.eventName)
    );
    const insertions = new Map<string, Hex>();
    const metadata = (log: DeliveryEventLog) => {
        check(!log.removed, "discovery resync required after reorg");
        check(
            typeof log.blockNumber === "bigint" &&
                log.blockNumber >= 0n &&
                log.blockNumber <= confirmedThrough,
            "event is not confirmed"
        );
        check(Number.isSafeInteger(log.logIndex) && log.logIndex! >= 0, "invalid log position");
        return {
            blockNumber: log.blockNumber,
            blockHash: hash(log.blockHash),
            transactionHash: hash(log.transactionHash),
        };
    };
    const insertionKey = (log: DeliveryEventLog, tree: bigint, at: number) =>
        `${hash(log.transactionHash)}:${position(tree, at)}`;
    for (const log of relevant) {
        metadata(log);
        if (log.eventName !== "CommitmentsInserted" && log.eventName !== "BatchOutputs") continue;
        const a = object(log.args),
            tree = integer(a.treeId),
            start = index(a.startLeafIndex),
            leaves = array(a.commitments);
        check(tree > 0n && tree < 1n << 64n, "invalid insertion tree");
        check(start + leaves.length <= 65536, "insertion exceeds tree capacity");
        for (const [i, leaf] of leaves.entries()) {
            const key = insertionKey(log, tree, start + i),
                value = hash(leaf),
                previous = insertions.get(key);
            check(!previous || previous === value, "conflicting insertion events");
            insertions.set(key, value);
        }
    }
    const results = new Map<string, DeliveryCandidate>();
    const add = (
        log: DeliveryEventLog,
        tree: bigint,
        at: number,
        commitment: unknown,
        role: DeliveryCandidate["role"],
        wire: unknown,
        token: unknown = log.args?.token ??
            (log.args?.params as { token?: unknown; creation?: { token?: unknown } } | undefined)
                ?.token ??
            (log.args?.params as { creation?: { token?: unknown } } | undefined)?.creation?.token
    ) => {
        check(tree > 0n && tree < 1n << 64n, "invalid output tree");
        const inserted = insertions.get(insertionKey(log, tree, at));
        check(inserted, "delivery has no matching canonical insertion");
        if (commitment !== undefined)
            check(hash(commitment) === inserted, "delivery commitment conflicts with insertion");
        const delivery = normalizeOpaqueDelivery(wire as never, { allowEmpty: role === "funds" });
        check(
            typeof token === "string" && isAddress(token) && BigInt(token) !== 0n,
            "invalid event token"
        );
        const value = {
            tokenAddress: token as Address,
            treeId: tree,
            leafIndex: at,
            commitment: inserted,
            role,
            delivery,
            ...metadata(log),
        };
        const key = `${insertionKey(log, tree, at)}:${role}`,
            previous = results.get(key);
        check(
            !previous ||
                (previous.tokenAddress.toLowerCase() === token.toLowerCase() &&
                    previous.delivery.ciphertext === delivery.ciphertext &&
                    previous.delivery.clue === delivery.clue &&
                    previous.blockHash === value.blockHash),
            "conflicting delivery events"
        );
        results.set(key, value);
    };
    const creation = (
        log: DeliveryEventLog,
        a: Record<string, unknown>,
        fields: Record<string, unknown>
    ) => {
        const tree = integer(a.outputTreeId),
            leaves = array(a.leafIndices),
            ds = array(a.deliveries);
        const change = hash(fields.changeCommitment),
            hasChange = BigInt(change) !== 0n;
        check(
            ds.length === 3 && leaves.length === (hasChange ? 2 : 1),
            "invalid Credit creation delivery slots"
        );
        add(log, tree, index(leaves[0]), fields.creditCommitment, "owner", ds[0]);
        add(log, tree, index(leaves[0]), fields.creditCommitment, "spender", ds[1]);
        if (hasChange) add(log, tree, index(leaves[1]), change, "funds", ds[2]);
        else normalizeOpaqueDelivery(ds[2] as never, { empty: true });
    };
    for (const log of relevant) {
        const a = object(log.args);
        if (log.eventName === "Shield") {
            const ds = array(a.deliveries),
                tree = integer(a.treeId),
                start = index(a.startLeafIndex);
            check(start + ds.length <= 65536, "shield exceeds tree capacity");
            ds.forEach((d, i) => add(log, tree, start + i, undefined, "funds", d));
        } else if (log.eventName === "Transact" || log.eventName === "CrossTreeTransact") {
            const cs = array(a.outputCommitments),
                ds = array(a.deliveries),
                leaves = array(a.leafIndices),
                tree = integer(a.outputTreeId);
            check(
                cs.length === ds.length && cs.length === leaves.length,
                "invalid transact delivery slots"
            );
            cs.forEach((c, i) => add(log, tree, index(leaves[i]), c, "funds", ds[i]));
        } else if (log.eventName === "BatchOutputs") {
            const tokens = array(a.tokens);
            const cs = array(a.commitments),
                tree = integer(a.treeId),
                start = index(a.startLeafIndex),
                packed = a.packedDeliveries;
            check(
                typeof packed === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(packed),
                "invalid packed deliveries"
            );
            check(tokens.length === cs.length, "batch token count mismatch");
            check(start + cs.length <= 65536, "batch exceeds tree capacity");
            let offset = 2;
            cs.forEach((c, i) => {
                check(offset + 4 <= packed.length, "truncated delivery length prefix");
                const length = Number.parseInt(packed.slice(offset, offset + 4), 16);
                offset += 4;
                check(
                    length <= MAX_CIPHERTEXT_BYTES &&
                        offset + length * 2 + (length === 0 ? 0 : 136) <= packed.length,
                    "invalid packed delivery length"
                );
                const ciphertext = `0x${packed.slice(offset, offset + length * 2)}`;
                offset += length * 2;
                const clue = length === 0 ? "0x" : `0x${packed.slice(offset, offset + 136)}`;
                if (length !== 0) offset += 136;
                add(log, tree, start + i, c, "funds", { ciphertext, clue }, tokens[i]);
            });
            check(offset === packed.length, "trailing packed delivery bytes");
        } else if (log.eventName === "CreditCreated") creation(log, a, a);
        else if (log.eventName === "CreditToppedUp")
            creation(log, a, object(object(a.params).creation));
        else if (log.eventName === "CreditDraw") {
            const p = object(a.params),
                cs = array(p.remainderCommitments),
                ds = array(a.deliveries),
                leaves = array(a.remainderLeafIndices),
                tree = integer(a.outputTreeId);
            check(
                ds.length === 2 * cs.length && leaves.length === cs.length,
                "invalid draw delivery slots"
            );
            cs.forEach((c, i) => {
                if (BigInt(hash(c)) === 0n) {
                    check(integer(leaves[i]) === 0n, "absent remainder has nonzero position");
                    normalizeOpaqueDelivery(ds[2 * i] as never, { empty: true });
                    normalizeOpaqueDelivery(ds[2 * i + 1] as never, { empty: true });
                } else {
                    add(log, tree, index(leaves[i]), c, "owner", ds[2 * i]);
                    add(log, tree, index(leaves[i]), c, "spender", ds[2 * i + 1]);
                }
            });
        }
    }
    return [...results.values()];
}
export interface DiscoveredNote extends Omit<DeliveryCandidate, "delivery" | "role"> {
    note: Note;
}
export interface DiscoveredCredit extends Omit<DeliveryCandidate, "delivery"> {
    role: "owner" | "spender";
    state: CreditDeliveryState;
}
/** Authenticate private deliveries from a single batch of canonical receipts. */
export async function decryptCandidates(
    logs: readonly DeliveryEventLog[],
    options: {
        context: DiscoveryContext;
        viewing: Pick<ViewingCapability, "ownerAddress" | "decryptNote" | "decryptCredit">;
        confirmedThrough: bigint;
    }
): Promise<{ notes: DiscoveredNote[]; credits: DiscoveredCredit[] }> {
    contextCheck(options.context);
    decodeAddress(ReceivingAddress.fromIdentity(options.viewing.ownerAddress).toString());
    check(
        !logs.some(
            (log) =>
                log.address.toLowerCase() === options.context.protocolAddress.toLowerCase() &&
                log.removed
        ),
        "discovery resync required after reorg"
    );
    const candidates = extractDeliveryCandidates(logs, options.context, options.confirmedThrough);
    const positions = new Map<string, DeliveryCandidate>();
    const unique = new Map<string, DeliveryCandidate>();
    for (const candidate of candidates) {
        const key = position(candidate.treeId, candidate.leafIndex);
        const previous = positions.get(key);
        check(
            !previous ||
                (previous.commitment === candidate.commitment &&
                    previous.blockHash === candidate.blockHash &&
                    previous.transactionHash === candidate.transactionHash &&
                    previous.tokenAddress.toLowerCase() === candidate.tokenAddress.toLowerCase()),
            "conflicting canonical position"
        );
        positions.set(key, candidate);
        unique.set(`${key}:${candidate.role}`, candidate);
    }
    const notes: DiscoveredNote[] = [];
    const credits: DiscoveredCredit[] = [];
    for (const candidate of unique.values()) {
        const { delivery, role, ...positionData } = candidate;
        const context = {
            chainId: options.context.chainId,
            protocolAddress: BigInt(options.context.protocolAddress),
            tokenAddress: BigInt(candidate.tokenAddress),
            outputCommitment: candidate.commitment,
        };
        // Non-recipient ciphertexts and failed authentication are normal scan outcomes.
        try {
            if (role === "funds") {
                if (delivery.ciphertext === "0x") continue;
                const note = await options.viewing.decryptNote(delivery.ciphertext, context);
                notes.push({ ...positionData, note });
            } else {
                const state = await options.viewing.decryptCredit(delivery.ciphertext, {
                    ...context,
                    role,
                });
                credits.push({ ...positionData, role, state });
            }
        } catch {
            /* Unrelated or invalid output: never add unauthenticated amounts. */
        }
    }
    return { notes, credits };
}
