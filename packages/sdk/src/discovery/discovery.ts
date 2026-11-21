import { extractNoteOutputs } from "./note-operations";
import { DeliveryAuthenticationError, validateDeliveryCiphertext } from "@invisi-labs/primitives";
import type { authenticatedDecryptor } from "@invisi-labs/primitives";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import { isAddress } from "ethers";

import {
    decodeAddress,
    ReceivingAddress,
    type CreditDeliveryState,
    type Note,
} from "@invisi-labs/primitives";
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
    "NoteOperation",
    "NoteStateTransition",
    "PublicDeposit",
    "PublicWithdrawal",
    "NoteOutputs",
    "TransactAggregated",
    "CreditCreated",
    "CreditStateTransition",
    "CreditDraw",
    "CreditUpdated",
    "CreditRevoked",
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
    const insertionBatches = new Map<string, string>();
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
        `${hash(log.blockHash)}:${hash(log.transactionHash)}:${position(tree, at)}`;
    for (const log of relevant) {
        metadata(log);
        if (log.eventName !== "CommitmentsInserted") continue;
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
            insertionBatches.set(key, `${log.logIndex}:${tree}:${start}:${leaves.length}`);
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
            leaf = index(a.leafIndex),
            ds = array(a.deliveries);
        check(ds.length === 2, "invalid Credit delivery slots");
        add(log, tree, leaf, fields.creditCommitment, "owner", ds[0]);
        add(log, tree, leaf, fields.creditCommitment, "spender", ds[1]);
    };
    const created = new Map<string, DeliveryEventLog>();
    for (const log of relevant) {
        if (log.eventName !== "CreditCreated") continue;
        const a = object(log.args);
        const key = insertionKey(log, integer(a.outputTreeId), index(a.leafIndex));
        check(!created.has(key), "duplicate Credit creation position");
        created.set(key, log);
    }
    const drawKey = (log: DeliveryEventLog) => {
        const a = object(log.args);
        return `${hash(log.blockHash)}:${hash(log.transactionHash)}:${integer(a.outputTreeId)}:${hash(a.noteCommitment)}`;
    };
    const draws = new Map<string, DeliveryEventLog>();
    const transitions = new Map<string, DeliveryEventLog>();
    for (const log of relevant) {
        if (log.eventName !== "CreditDraw" && log.eventName !== "CreditStateTransition") continue;
        const map = log.eventName === "CreditDraw" ? draws : transitions;
        const key = drawKey(log);
        check(!map.has(key), "duplicate Credit draw result or transition");
        map.set(key, log);
    }
    const sameInsertion = (
        left: DeliveryEventLog,
        tree: bigint,
        at: number,
        right: DeliveryEventLog,
        to: number
    ) => {
        const a = insertionBatches.get(insertionKey(left, tree, at));
        check(
            a !== undefined && a === insertionBatches.get(insertionKey(right, tree, to)),
            "Credit outputs have no matching insertion batch"
        );
    };
    for (const group of extractNoteOutputs(relevant, context)) {
        group.commitments.forEach((c, i) =>
            add(
                group.log,
                group.tree,
                group.start + i,
                c,
                "funds",
                group.deliveries[i],
                group.token
            )
        );
    }
    for (const log of relevant) {
        const a = object(log.args);
        if (log.eventName === "CreditCreated") creation(log, a, a);
        else if (log.eventName === "CreditDraw") {
            const tree = integer(a.outputTreeId),
                leaf = index(a.noteLeafIndex);
            const transition = transitions.get(drawKey(log));
            const grant = leaf > 0 ? created.get(insertionKey(log, tree, leaf - 1)) : undefined;
            check(transition || grant, "draw has no matching Credit creation or transition");
            check(!(transition && grant), "ambiguous Credit draw association");
            if (grant) {
                check(
                    grant.logIndex! < log.logIndex! &&
                        String(grant.args?.token).toLowerCase() === String(a.token).toLowerCase(),
                    "draw has no matching Credit creation"
                );
                sameInsertion(grant, tree, leaf - 1, log, leaf);
            }
            const total = integer(a.totalAmount),
                fee = integer(a.feeAmount);
            check(total > 0n && total < 1n << 128n && fee < total, "invalid draw amount or fee");
            add(log, tree, leaf, a.noteCommitment, "funds", a.delivery);
        } else if (log.eventName === "CreditUpdated") creation(log, a, object(a.params));
        else if (log.eventName === "CreditStateTransition") {
            const result = draws.get(drawKey(log));
            check(
                result && result.logIndex! > log.logIndex!,
                "transition has no matching subsequent Credit draw"
            );
            const r = object(result.args),
                p = object(a.state),
                cs = array(p.creditCommitments),
                ns = array(p.nullifiers),
                recovery = array(p.recoveryAmounts),
                refs = array(p.grantRefs),
                payers = array(p.payers),
                sources = array(p.sources),
                ds = array(a.creditDeliveries),
                leaves = array(a.creditLeafIndices),
                tree = integer(a.outputTreeId),
                noteLeaf = index(r.noteLeafIndex),
                n = cs.length;
            check(
                n > 0 &&
                    n <= 80 &&
                    ns.length === n &&
                    recovery.length === n &&
                    refs.length === n &&
                    ds.length === 2 * n &&
                    leaves.length === n &&
                    sources.length > 0 &&
                    sources.length <= n &&
                    payers.length > 0 &&
                    payers.length <= n,
                "invalid draw state or delivery slots"
            );
            check(new Set(ns.map(hash)).size === n, "duplicate Credit nullifiers");
            recovery.forEach(hash);
            sources.forEach((value) => {
                const source = object(value);
                check(integer(source.treeId) > 0n, "invalid source tree");
                hash(source.merkleRoot);
            });
            refs.forEach((value) => {
                const ref = object(value);
                check(
                    integer(ref.payerIndex) < BigInt(payers.length) &&
                        integer(ref.grantId) > 0n &&
                        integer(ref.grantId) < 1n << 128n,
                    "invalid Credit grant reference"
                );
            });
            const total = payers.reduce<bigint>((sum, value) => {
                const payer = object(value),
                    amount = integer(payer.amount);
                check(
                    typeof payer.payer === "string" &&
                        isAddress(payer.payer) &&
                        BigInt(payer.payer) !== 0n &&
                        amount > 0n,
                    "invalid Credit payer"
                );
                return sum + amount;
            }, 0n);
            check(total === integer(r.totalAmount), "draw payer total mismatch");
            cs.forEach((c, i) => {
                const leaf = index(leaves[i]);
                check(leaf + n - i === noteLeaf, "noncontiguous Credit draw output positions");
                sameInsertion(log, tree, leaf, result, noteLeaf);
                add(log, tree, leaf, c, "owner", ds[2 * i], r.token);
                add(log, tree, leaf, c, "spender", ds[2 * i + 1], r.token);
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
        viewing: Pick<
            ReturnType<typeof authenticatedDecryptor>,
            "ownerAddress" | "decryptNote" | "decryptCredit"
        > &
            Partial<Pick<ReturnType<typeof authenticatedDecryptor>, "detectCandidates">>;
        confirmedThrough: bigint;
        roles?: readonly DeliveryCandidate["role"][];
    }
): Promise<{
    notes: DiscoveredNote[];
    credits: DiscoveredCredit[];
    unresolved?: DeliveryCandidate[];
}> {
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
    const unresolved: DeliveryCandidate[] = [];
    const list = [...unique.values()].filter(
        (candidate) => !options.roles || options.roles.includes(candidate.role)
    );
    if (!list.length) return { notes, credits };
    const detection = options.viewing.detectCandidates
        ? await options.viewing.detectCandidates(
              list.map((candidate) => ({
                  chainId: options.context.chainId,
                  protocolAddress: BigInt(options.context.protocolAddress),
                  tokenAddress: BigInt(candidate.tokenAddress),
                  outputCommitment: candidate.commitment,
                  ownerAddress: options.viewing.ownerAddress,
                  role: candidate.role,
                  clue: candidate.delivery.clue,
                  ciphertext: candidate.delivery.ciphertext,
              }))
          )
        : list.map(() => "candidate" as const);
    for (const [index, candidate] of list.entries()) {
        if (detection[index] === "not-recipient") continue;
        if (detection[index] === "unresolved") {
            unresolved.push(candidate);
            continue;
        }
        const { delivery, role, ...positionData } = candidate;
        if (role === "funds" && delivery.ciphertext === "0x") continue;
        try {
            validateDeliveryCiphertext(delivery.ciphertext, role === "funds" ? "funds" : "credit");
        } catch {
            unresolved.push(candidate);
            continue;
        }
        const context = {
            chainId: options.context.chainId,
            protocolAddress: BigInt(options.context.protocolAddress),
            tokenAddress: BigInt(candidate.tokenAddress),
            outputCommitment: candidate.commitment,
            clue: delivery.clue,
        };
        // Authentication ambiguity is retained, never asserted to be a nonrecipient.
        try {
            if (role === "funds") {
                if (delivery.ciphertext === "0x") continue;
                const note = await options.viewing.decryptNote(delivery.ciphertext, context);
                if (note !== null) notes.push({ ...positionData, note });
            } else {
                const state = await options.viewing.decryptCredit(delivery.ciphertext, {
                    ...context,
                    role,
                });
                if (state !== null) credits.push({ ...positionData, role, state });
            }
        } catch (error) {
            if (error instanceof DeliveryAuthenticationError) {
                unresolved.push(candidate);
                continue;
            }
            throw error;
        }
    }
    return { notes, credits, ...(unresolved.length ? { unresolved } : {}) };
}
