import { normalizeFee } from "../fees/fee";
import { Interface, getAddress } from "ethers";
import { creditPeriods, walletAuthorizationTypedData } from "@invisi-labs/core";
import {
    invisiProtocolAbi,
    type Hex,
    type CreditDrawParams,
    type UpdateCreditParams,
    type RevokeCreditParams,
    type Delivery,
    type CreditGrantRef,
} from "../contracts/index";
import {
    normalizeContext,
    normalizeSources,
    normalizeOpaqueDelivery,
    known,
    uint,
    word,
    field,
    notes,
    dense,
    checkDeadline,
    deliveriesHash,
    pad,
    type TransactionContext,
} from "../validation";
import { authorizedCreditInputs, encodeCreditProof } from "./credit-create";
export const CREDIT_DRAW_CAPACITIES = [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80] as const;
export function selectCreditDrawCircuit(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 80)
        throw Error("draw requires1..80 grants");
    const capacity = CREDIT_DRAW_CAPACITIES.find((n) => count <= n)!;
    return {
        name: `credit_draw_slots${capacity}`,
        capacity,
        publicInputCount: 17 + 10 * capacity,
    };
}
const nonzero = (v: Hex) => {
    const w = word(field(v));
    if (!BigInt(w)) throw Error("zero commitment or nullifier");
    return w;
};
export function validateCreditDrawRequest(
    c: TransactionContext,
    p: CreditDrawParams,
    d: readonly Delivery[]
) {
    known(p, [
        "token",
        "sources",
        "payers",
        "grantRefs",
        "nullifiers",
        "creditCommitments",
        "recoveryAmounts",
        "noteCommitment",
        "totalAmount",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
    const ctx = normalizeContext(c),
        ns = notes(p.nullifiers, "nullifiers").map(nonzero),
        profile = selectCreditDrawCircuit(ns.length),
        sources = normalizeSources(p.sources, ns.length, profile.capacity);
    if (getAddress(p.token) !== ctx.tokenAddress) throw Error("token context mismatch");
    for (const k of ["creditCommitments", "recoveryAmounts"] as const)
        if (dense(p[k], k).length !== ns.length) throw Error(`${k} count mismatch`);
    const creditCommitments = p.creditCommitments.map(nonzero),
        recoveryAmounts = p.recoveryAmounts.map((v) => word(field(v))),
        noteCommitment = nonzero(p.noteCommitment);
    if (new Set([...creditCommitments, noteCommitment]).size !== ns.length + 1)
        throw Error("duplicate commitment");
    let prev = 0n;
    if (!dense(p.payers, "payers").length || p.payers.length > ns.length)
        throw Error("payer count out of bounds");
    const payers = p.payers.map((payer) => {
        known(payer, ["payer", "amount"]);
        const address = getAddress(payer.payer) as Hex,
            amount = uint(payer.amount, 128, "payer amount");
        if (BigInt(address) <= prev || !amount)
            throw Error("payers must be sorted unique positive addresses with positive receipts");
        prev = BigInt(address);
        return { payer: address, amount };
    });
    if (dense(p.grantRefs, "grantRefs").length !== ns.length)
        throw Error("grant reference count mismatch");
    let previous: CreditGrantRef | undefined;
    const grantRefs = p.grantRefs.map((ref) => {
        known(ref, ["payerIndex", "shard", "slot"]);
        const r = {
            payerIndex: uint(ref.payerIndex, 32),
            shard: uint(ref.shard, 64),
            slot: uint(ref.slot, 16),
        };
        if (r.payerIndex >= BigInt(payers.length) || !r.shard)
            throw Error("invalid grant namespace");
        if (
            previous &&
            (r.payerIndex < previous.payerIndex ||
                (r.payerIndex === previous.payerIndex &&
                    (r.shard < previous.shard ||
                        (r.shard === previous.shard && r.slot <= previous.slot))))
        )
            throw Error("grant references must be sorted unique payer/shard/slot");
        previous = r;
        return r;
    });
    const totalAmount = uint(p.totalAmount, 128, "totalAmount");
    if (!totalAmount || payers.reduce((sum, p) => sum + p.amount, 0n) !== totalAmount)
        throw Error("payer receipts must equal totalAmount");
    if (normalizeFee(p).feeAmount >= totalAmount)
        throw Error("Credit draw fee must leave a positive ordinary Note");
    if (dense(d, "deliveries").length !== 2 * ns.length + 1)
        throw Error("deliveries count mismatch");
    if (c.timestamp === undefined) throw Error("explicit Credit draw timestamp required");
    return {
        ...ctx,
        ...normalizeFee(p),
        profile,
        sources,
        payers,
        grantRefs,
        nullifiers: ns,
        creditCommitments,
        recoveryAmounts,
        noteCommitment,
        totalAmount,
        deadline: checkDeadline(c, p.deadline),
        periods: creditPeriods(c.timestamp),
        deliveries: d.map((v, i) =>
            normalizeOpaqueDelivery(v, { allowEmpty: i === 2 * ns.length })
        ),
    };
}
export function creditDrawBaseInputs(
    c: TransactionContext,
    p: CreditDrawParams,
    d: readonly Delivery[]
) {
    const r = validateCreditDrawRequest(c, p, d),
        n = r.profile.capacity,
        h = BigInt(deliveriesHash(d));
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.nullifiers.length),
        BigInt(r.sources.length),
        BigInt(r.payers.length),
        ...pad(
            r.sources.map((s) => s.treeId),
            n
        ),
        ...pad(
            r.sources.map((s) => BigInt(s.merkleRoot)),
            n
        ),
        ...pad(
            r.payers.map((s) => BigInt(s.payer)),
            n
        ),
        ...pad(
            r.payers.map((s) => s.amount),
            n
        ),
        ...pad(
            r.grantRefs.map((s) => s.payerIndex),
            n
        ),
        ...pad(
            r.grantRefs.map((s) => s.shard),
            n
        ),
        ...pad(
            r.grantRefs.map((s) => s.slot),
            n
        ),
        ...pad(r.nullifiers.map(BigInt), n),
        ...pad(r.creditCommitments.map(BigInt), n),
        ...pad(r.recoveryAmounts.map(BigInt), n),
        BigInt(r.noteCommitment),
        r.totalAmount,
        r.deadline,
        h >> 128n,
        h & ((1n << 128n) - 1n),
        r.periods.currentDay,
        r.periods.currentMonth,
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
export function creditDrawPublicInputs(
    c: TransactionContext,
    p: CreditDrawParams,
    d: readonly Delivery[]
) {
    return authorizedCreditInputs(
        c,
        "credit-draw",
        selectCreditDrawCircuit(p.nullifiers.length).capacity,
        creditDrawBaseInputs(c, p, d)
    );
}
export function encodeCreditDrawTypedData(
    c: TransactionContext,
    p: CreditDrawParams,
    d: readonly Delivery[]
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation: "credit-draw",
        capacity: selectCreditDrawCircuit(p.nullifiers.length).capacity,
        words: creditDrawBaseInputs(c, p, d).map(BigInt),
    });
}
export function validateUpdateCreditRequest(
    c: TransactionContext,
    p: UpdateCreditParams,
    d: readonly Delivery[]
) {
    known(p, [
        "token",
        "owner",
        "source",
        "nullifier",
        "creditCommitment",
        "revocationShard",
        "revocationSlot",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
    const ctx = normalizeContext(c),
        owner = getAddress(p.owner) as Hex,
        revocationShard = uint(p.revocationShard, 64);
    if (getAddress(p.token) !== ctx.tokenAddress || !BigInt(owner) || !revocationShard)
        throw Error("invalid update authority or token");
    if (dense(d, "deliveries").length !== 2) throw Error("deliveries count mismatch");
    return {
        ...ctx,
        ...normalizeFee(p),
        owner,
        source: normalizeSources([p.source], 1, 1)[0]!,
        nullifier: nonzero(p.nullifier),
        creditCommitment: nonzero(p.creditCommitment),
        revocationShard,
        revocationSlot: uint(p.revocationSlot, 16),
        deadline: checkDeadline(c, p.deadline),
        deliveries: d.map((v) => normalizeOpaqueDelivery(v, {})),
    };
}
export function updateCreditBaseInputs(
    c: TransactionContext,
    p: UpdateCreditParams,
    d: readonly Delivery[]
) {
    const r = validateUpdateCreditRequest(c, p, d),
        h = BigInt(deliveriesHash(d));
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.owner),
        r.source.treeId,
        BigInt(r.source.merkleRoot),
        BigInt(r.nullifier),
        BigInt(r.creditCommitment),
        r.revocationShard,
        r.revocationSlot,
        r.deadline,
        h >> 128n,
        h & ((1n << 128n) - 1n),
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
export function updateCreditPublicInputs(
    c: TransactionContext,
    p: UpdateCreditParams,
    d: readonly Delivery[]
) {
    return authorizedCreditInputs(c, "update-credit", 1, updateCreditBaseInputs(c, p, d));
}
export function encodeUpdateCreditTypedData(
    c: TransactionContext,
    p: UpdateCreditParams,
    d: readonly Delivery[]
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation: "update-credit",
        capacity: 1,
        words: updateCreditBaseInputs(c, p, d).map(BigInt),
    });
}
export interface BuildCreditDrawCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: CreditDrawParams;
    deliveries: readonly Delivery[];
}
export function buildCreditDrawCalldata(p: BuildCreditDrawCalldataParams) {
    const r = validateCreditDrawRequest(p.context, p.params, p.deliveries);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("creditDraw", [
            encodeCreditProof(p.proof),
            { ...p.params, ...normalizeFee(p.params) },
            p.deliveries,
        ]) as Hex,
        approveAmount: 0n,
        approvalRequirements: r.payers.map((payer) => ({
            token: r.tokenAddress,
            payer: payer.payer,
            amount: payer.amount,
        })),
    };
}
export interface BuildUpdateCreditCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: UpdateCreditParams;
    deliveries: readonly Delivery[];
}
export function buildUpdateCreditCalldata(p: BuildUpdateCreditCalldataParams) {
    const r = validateUpdateCreditRequest(p.context, p.params, p.deliveries);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("updateCredit", [
            encodeCreditProof(p.proof),
            { ...p.params, ...normalizeFee(p.params) },
            p.deliveries,
        ]) as Hex,
        approveAmount: r.feeAmount,
        approvalRequirements: r.feeAmount
            ? [{ token: r.tokenAddress, payer: r.owner, amount: r.feeAmount }]
            : [],
    };
}
export const REVOKE_CREDIT_TYPES = {
    RevokeCredit: [
        { name: "token", type: "address" },
        { name: "owner", type: "address" },
        { name: "shard", type: "uint64" },
        { name: "slot", type: "uint16" },
        { name: "deadline", type: "uint256" },
        { name: "feeRecipient", type: "address" },
        { name: "feeAmount", type: "uint256" },
    ],
};
export function encodeRevokeCreditTypedData(c: TransactionContext, p: RevokeCreditParams) {
    known(p, ["token", "owner", "shard", "slot", "deadline", "feeRecipient", "feeAmount"]);
    if (
        getAddress(p.token) !== getAddress(c.tokenAddress) ||
        !BigInt(p.owner) ||
        !uint(p.shard, 64)
    )
        throw Error("invalid revocation authority");
    return {
        domain: {
            name: "InvisibleProtocol",
            version: "1",
            chainId: c.chainId,
            verifyingContract: c.protocolAddress,
        },
        types: REVOKE_CREDIT_TYPES,
        primaryType: "RevokeCredit" as const,
        message: {
            token: getAddress(p.token),
            owner: getAddress(p.owner),
            shard: uint(p.shard, 64),
            slot: uint(p.slot, 16),
            deadline: checkDeadline(c, p.deadline),
            ...normalizeFee(p),
        },
    };
}
export interface BuildRevokeCreditCalldataParams {
    context: TransactionContext;
    params: RevokeCreditParams;
    signature: Hex;
    caller?: Hex;
}
export function buildRevokeCreditCalldata(p: BuildRevokeCreditCalldataParams) {
    encodeRevokeCreditTypedData(p.context, p.params);
    if (p.signature === "0x" && (!p.caller || getAddress(p.caller) !== getAddress(p.params.owner)))
        throw Error("direct revocation requires owner caller");
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("revokeCredit", [
            p.params.token,
            p.params.owner,
            p.params.shard,
            p.params.slot,
            p.params.deadline,
            normalizeFee(p.params).feeRecipient,
            normalizeFee(p.params).feeAmount,
            p.signature,
        ]) as Hex,
        approveAmount: normalizeFee(p.params).feeAmount,
        approvalRequirements: normalizeFee(p.params).feeAmount
            ? [
                  {
                      token: p.params.token,
                      payer: p.params.owner,
                      amount: normalizeFee(p.params).feeAmount,
                  },
              ]
            : [],
    };
}
