import { isAddress } from "ethers/address";
import { ZeroAddress } from "ethers/constants";
import { noteOperationId } from "@invisi-labs/protocol/note";
import type { Address, Delivery, Hex, InputSource } from "@invisi-labs/protocol/contracts";
import type { DeliveryEventLog, DiscoveryContext } from "./discovery";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
const obj = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("invalid Note event object");
    return v as Record<string, unknown>;
};
const integer = (v: unknown): bigint => {
    if (typeof v !== "bigint" && !(typeof v === "number" && Number.isSafeInteger(v)))
        throw new Error("invalid Note event integer");
    const n = BigInt(v);
    if (n < 0n) throw new Error("invalid Note event integer");
    return n;
};
const list = (v: unknown): unknown[] => {
    if (!Array.isArray(v) || Array.from({ length: v.length }, (_, i) => i in v).some((x) => !x))
        throw new Error("invalid Note event array");
    return v;
};
const hash = (v: unknown): Hex => {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v))
        throw new Error("invalid Note event hash");
    return v.toLowerCase() as Hex;
};
const address = (v: unknown): Address => {
    if (typeof v !== "string" || !isAddress(v)) throw new Error("invalid Note event address");
    return v as Address;
};
const scope = (l: DeliveryEventLog) => `${l.blockHash}:${l.transactionHash}`;
const key = (l: DeliveryEventLog, id: unknown) => `${scope(l)}:${hash(id)}`;
interface Operation {
    log: DeliveryEventLog;
    id: Hex;
    token: Address;
    kind: 0 | 1;
    count: number;
    deadline: bigint;
    feeRecipient: Address;
    feeAmount: bigint;
    sources: InputSource[];
    nullifiers: Hex[];
    payer: Address;
    deposit: bigint;
    recipient: Address;
    withdrawal: bigint;
    output?: {
        log: DeliveryEventLog;
        tree: bigint;
        start: number;
        deliveries: Delivery[];
        commitments: Hex[];
    };
}
export function extractNoteOutputs(logs: readonly DeliveryEventLog[], context: DiscoveryContext) {
    const operations = new Map<string, Operation>(),
        seen = new Set<string>(),
        claimed = new Set<string>();
    const insertions = logs.filter((l) => l.eventName === "CommitmentsInserted");
    for (const l of logs)
        if (l.eventName === "NoteOperation") {
            const a = obj(l.args),
                k = key(l, a.operationId),
                kind = integer(a.kind),
                count = integer(a.outputCount);
            check(!operations.has(k), "duplicate Note operation");
            check(kind <= 1n && count <= 190n, "invalid Note operation");
            operations.set(k, {
                log: l,
                id: hash(a.operationId),
                token: address(a.token),
                kind: Number(kind) as 0 | 1,
                count: Number(count),
                deadline: integer(a.deadline),
                feeRecipient: address(a.feeRecipient),
                feeAmount: integer(a.feeAmount),
                sources: [],
                nullifiers: [],
                payer: ZeroAddress as Address,
                deposit: 0n,
                recipient: ZeroAddress as Address,
                withdrawal: 0n,
            });
        }
    for (const l of logs) {
        if (
            !["NoteOutputs", "NoteStateTransition", "PublicDeposit", "PublicWithdrawal"].includes(
                l.eventName
            )
        )
            continue;
        const a = obj(l.args),
            k = key(l, a.operationId),
            op = operations.get(k);
        check(op, "event has no matching Note operation");
        check(!seen.has(k + l.eventName), "duplicate operation fact");
        seen.add(k + l.eventName);
        if (l.eventName === "NoteStateTransition") {
            op.sources = list(a.sources).map((s) => {
                const x = obj(s);
                return { treeId: integer(x.treeId), merkleRoot: hash(x.merkleRoot) };
            });
            op.nullifiers = list(a.nullifiers).map(hash);
            check(
                op.kind === 1 &&
                    op.nullifiers.length > 0 &&
                    op.sources.length > 0 &&
                    op.sources.length <= op.nullifiers.length &&
                    new Set(op.nullifiers).size === op.nullifiers.length,
                "invalid Note state transition"
            );
            let last = 0n;
            for (const s of op.sources) {
                check(
                    s.treeId > last && s.treeId < 1n << 64n && BigInt(s.merkleRoot) > 0n,
                    "invalid source order"
                );
                last = s.treeId;
            }
        } else if (l.eventName === "PublicDeposit" || l.eventName === "PublicWithdrawal") {
            const amount = integer(a.amount);
            check(
                address(a.token).toLowerCase() === op.token.toLowerCase() &&
                    amount > 0n &&
                    amount < 1n << 128n,
                "invalid public flow"
            );
            if (l.eventName === "PublicDeposit") {
                op.payer = address(a.payer);
                op.deposit = amount;
            } else {
                op.recipient = address(a.recipient);
                op.withdrawal = amount;
            }
        } else {
            const tree = integer(a.treeId),
                start = integer(a.startLeafIndex),
                packed = a.packedDeliveries;
            check(
                op.count > 0 &&
                    tree > 0n &&
                    tree < 1n << 64n &&
                    start + BigInt(op.count) <= 65536n &&
                    typeof packed === "string" &&
                    /^0x(?:[0-9a-fA-F]{2})*$/.test(packed),
                "invalid output range or packed delivery"
            );
            const matches = insertions.filter((i) => {
                const b = obj(i.args);
                return (
                    scope(i) === scope(l) &&
                    integer(b.treeId) === tree &&
                    start >= integer(b.startLeafIndex) &&
                    start + BigInt(op.count) <=
                        integer(b.startLeafIndex) + BigInt(list(b.commitments).length)
                );
            });
            check(matches.length === 1, "output range has no unique matching insertion");
            const insertion = obj(matches[0]!.args),
                offset = Number(start - integer(insertion.startLeafIndex)),
                commitments = list(insertion.commitments)
                    .slice(offset, offset + op.count)
                    .map(hash),
                deliveries: Delivery[] = [];
            let at = 2;
            for (let i = 0; i < op.count; i++) {
                check(at + 4 <= packed.length, "truncated delivery length prefix");
                const n = Number.parseInt(packed.slice(at, at + 4), 16);
                at += 4;
                check(
                    n <= 4096 && at + n * 2 + (n ? 136 : 0) <= packed.length,
                    "invalid packed delivery length"
                );
                const ciphertext = `0x${packed.slice(at, at + n * 2)}` as Hex;
                at += n * 2;
                const clue = (n ? `0x${packed.slice(at, at + 136)}` : "0x") as Hex;
                if (n) at += 136;
                deliveries.push({ ciphertext, clue });
                const pos = `${scope(l)}:${tree}:${start + BigInt(i)}`;
                check(!claimed.has(pos), "overlapping output ranges");
                claimed.add(pos);
            }
            check(at === packed.length, "trailing packed delivery bytes");
            op.output = { log: l, tree, start: Number(start), deliveries, commitments };
        }
    }
    for (const op of operations.values()) {
        check(
            op.token !== ZeroAddress &&
                op.deadline < 1n << 64n &&
                (op.feeAmount === 0n) === (BigInt(op.feeRecipient) === 0n),
            "invalid Note operation context"
        );
        check((op.output?.deliveries.length ?? 0) === op.count, "operation output count mismatch");
        if (op.kind === 0)
            check(
                op.count > 0 &&
                    op.count <= 10 &&
                    op.nullifiers.length === 0 &&
                    op.deposit > 0n &&
                    op.withdrawal === 0n,
                "invalid Shield operation"
            );
        else check(op.nullifiers.length > 0 || op.deposit > 0n, "unfunded Note operation");
        const actual = noteOperationId(
            context,
            op.kind,
            {
                token: op.token,
                sources: op.sources,
                nullifiers: op.nullifiers,
                noteCommitments: op.output?.commitments ?? [],
                withdrawalAddress: op.recipient,
                withdrawalAmount: op.withdrawal,
                deadline: op.deadline,
                feeRecipient: op.feeRecipient,
                feeAmount: op.feeAmount,
            },
            op.output?.deliveries ?? [],
            { payer: op.payer, amount: op.deposit }
        );
        check(actual === op.id, "Note operation hash mismatch");
    }
    const members = new Set<string>();
    for (const l of logs)
        if (l.eventName === "TransactAggregated") {
            const ids = list(obj(l.args).operationIds).map(hash);
            check(
                ids.length > 0 && ids.length <= 5 && new Set(ids).size === ids.length,
                "invalid aggregate membership"
            );
            for (const id of ids) {
                const k = key(l, id),
                    op = operations.get(k);
                check(
                    op && op.kind === 1 && op.log.logIndex! < l.logIndex! && !members.has(k),
                    "invalid aggregate operation association"
                );
                members.add(k);
            }
        }
    return [...operations.values()]
        .filter((op): op is Operation & { output: NonNullable<Operation["output"]> } => !!op.output)
        .map((op) => ({ ...op.output, token: op.token }));
}
