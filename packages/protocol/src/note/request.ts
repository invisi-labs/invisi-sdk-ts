import { getAddress } from "ethers";
import type { Hex } from "../contracts/index";
import { type CrossTreeTransactParams, type Delivery } from "../contracts/index";
import {
    checkDeadline,
    deliveriesHash,
    dense,
    known,
    normalizeContext,
    normalizeFunding,
    normalizeOpaqueDelivery,
    normalizeSources,
    notes,
    pad,
    uint,
    word,
    type FundingInput,
    type TransactionContext,
} from "../validation";

export const TRANSACT_CAPACITIES = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
    160, 170, 180, 190,
] as const;

export type TransactCapacity = (typeof TRANSACT_CAPACITIES)[number];

export function selectTransactCapacity(inputs: number, outputs: number): TransactCapacity {
    if (
        !Number.isInteger(inputs) ||
        !Number.isInteger(outputs) ||
        inputs < 0 ||
        outputs < 0 ||
        inputs + outputs < 1 ||
        (inputs === 0 && outputs < 2) ||
        inputs + outputs > 190
    )
        throw new Error("unsupported transact shape");
    return TRANSACT_CAPACITIES.find((n) => inputs + outputs <= n)!;
}

export type TransactRequestParams = CrossTreeTransactParams;

export function normalizeTransactRequest(
    c: TransactionContext,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    funding: FundingInput = {}
) {
    const ctx = normalizeContext(c);
    if ((getAddress(p.token) as Hex) !== ctx.tokenAddress)
        throw new Error("request token mismatch");
    known(p, [
        "token",
        "sources",
        "nullifiers",
        "outputCommitments",
        "withdrawalAddress",
        "withdrawalAmount",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
    const ns = notes(p.nullifiers, "nullifiers"),
        os = notes(p.outputCommitments, "outputCommitments"),
        capacity = selectTransactCapacity(ns.length, os.length);
    const sources = normalizeSources(p.sources, ns.length, capacity),
        deliveries = dense(cs, "deliveries").map((v) =>
            normalizeOpaqueDelivery(v, { allowEmpty: true })
        );
    if (deliveries.length !== os.length) throw new Error("deliveries count mismatch");
    const withdrawalAmount = uint(p.withdrawalAmount, 128, "withdrawalAmount"),
        withdrawalAddress = getAddress(p.withdrawalAddress) as Hex,
        f = normalizeFunding(funding);
    const feeAmount = uint(p.feeAmount ?? 0n, 128, "feeAmount");
    const feeRecipient = getAddress(
        p.feeRecipient ?? "0x0000000000000000000000000000000000000000"
    ) as Hex;
    if ((feeAmount === 0n) !== (BigInt(feeRecipient) === 0n)) throw new Error("invalid fee");
    if (
        (withdrawalAmount === 0n) !== (BigInt(withdrawalAddress) === 0n) ||
        (os.length === 0 && withdrawalAmount === 0n)
    )
        throw new Error("invalid withdrawal");
    if (ns.length === 0 && (f.amount === 0n || withdrawalAmount !== 0n))
        throw new Error("zero inputs require positive funding and zero withdrawal");
    return {
        ...ctx,
        capacity,
        sources,
        nullifiers: ns,
        outputCommitments: os,
        inputCount: ns.length,
        outputCount: os.length,
        sourceCount: sources.length,
        inputTreeIds: pad(
            sources.map((s) => s.treeId),
            capacity
        ),
        merkleRoots: pad(
            sources.map((s) => BigInt(s.merkleRoot)),
            capacity
        ),
        slotValues: pad([...ns, ...os].map(BigInt), capacity),
        deliveries,
        deliveriesHash: deliveriesHash(deliveries),
        withdrawalAddress,
        withdrawalAmount,
        feeRecipient,
        feeAmount,
        deadline: checkDeadline(c, p.deadline),
        depositAmount: f.amount,
        depositPayer: f.payer,
        funding: f,
    };
}

export function transactPublicInputs(
    c: TransactionContext,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = normalizeTransactRequest(c, p, cs, f),
        h = BigInt(r.deliveriesHash);
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.inputCount),
        BigInt(r.outputCount),
        BigInt(r.sourceCount),
        ...r.inputTreeIds,
        ...r.merkleRoots,
        ...r.slotValues,
        h >> 128n,
        h & ((1n << 128n) - 1n),
        BigInt(r.withdrawalAddress),
        r.withdrawalAmount,
        r.deadline,
        r.depositAmount,
        BigInt(r.depositPayer),
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
