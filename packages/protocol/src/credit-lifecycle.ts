import { normalizeFee } from "./fee";
import type { Address, Hex } from "./contracts";
import { AbiCoder, getAddress, Interface, keccak256, ParamType } from "ethers";

import {
    invisiProtocolAbi,
    type CancelCreditParams,
    type CreditDrawParams,
    type Delivery,
    type TopUpCreditParams,
} from "./contracts";
import {
    creditPeriods,
    computeWalletAuthorizationDigest,
    walletAuthorizationTypedData,
    type WalletOperation,
} from "@invisi-labs/core";
import {
    createCreditBaseInputs,
    encodeCreditProof,
    validateCreateCreditRequest,
} from "./credit-create";
import {
    checkDeadline,
    deliveriesHash,
    dense,
    field,
    fundingFields,
    getEIP712Domain,
    known,
    normalizeContext,
    normalizeOpaqueDelivery,
    normalizeSources,
    notes,
    pad,
    uint,
    validateFundingSubmission,
    word,
    ZERO_ADDRESS,
    type FundingInput,
    type TransactionContext,
} from "./validation";
export const CREDIT_DRAW_CAPACITIES = [1, 12, 50, 120] as const;
export function selectCreditDrawCircuit(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 120)
        throw new Error("draw requires 1..120 credits");
    const maxSize = CREDIT_DRAW_CAPACITIES.find((n) => count <= n)!;
    return {
        name: `credit_draw_slots${maxSize}`,
        maxSize,
        publicInputCount: 6 * maxSize + 14,
        totalBits: 126 + Math.ceil(Math.log2(maxSize)),
    };
}
export function validateCreditDrawRequest(
    c: TransactionContext,
    p: CreditDrawParams,
    cs: readonly Delivery[]
) {
    known(p, [
        "token",
        "sources",
        "nullifiers",
        "remainderCommitments",
        "expiries",
        "recoveryAmounts",
        "spender",
        "totalAmount",
        "deadline",
    ]);
    if ((getAddress(p.token) as Hex) !== (getAddress(c.tokenAddress) as Hex))
        throw new Error("request token mismatch");
    const ctx = normalizeContext(c),
        ns = notes(p.nullifiers, "nullifiers"),
        profile = selectCreditDrawCircuit(ns.length),
        sources = normalizeSources(p.sources, ns.length, profile.maxSize);
    for (const [key, v] of Object.entries({
        remainderCommitments: p.remainderCommitments,
        expiries: p.expiries,
        recoveryAmounts: p.recoveryAmounts,
    }))
        if (dense<unknown>(v, key).length !== ns.length) throw new Error(`${key} count mismatch`);
    const remainderCommitments = p.remainderCommitments.map((v) => word(field(v))),
        recoveryAmounts = p.recoveryAmounts.map((v) => word(field(v))),
        expiries = p.expiries.map((v) => uint(v, 64, "expiry")),
        positives = remainderCommitments.filter((v) => BigInt(v) !== 0n);
    if (new Set(positives).size !== positives.length)
        throw new Error("duplicate remainder commitment");
    for (let i = 0; i < ns.length; i++) {
        if (expiries[i] === 0n || (c.now !== undefined && expiries[i]! <= c.now))
            throw new Error("expiry must be future");
        if (BigInt(remainderCommitments[i]!) === 0n && BigInt(recoveryAmounts[i]!) !== 0n)
            throw new Error("full draw requires zero recovery amount");
    }
    const spender = getAddress(p.spender) as Hex,
        totalAmount = uint(p.totalAmount, profile.totalBits, "totalAmount");
    if (BigInt(spender) === 0n || totalAmount === 0n)
        throw new Error("spender and total amount must be positive");
    if (dense(cs, "deliveries").length !== 2 * ns.length)
        throw new Error("deliveries count mismatch");
    const deliveries = cs.map((v, i) =>
        BigInt(remainderCommitments[Math.floor(i / 2)]!) === 0n
            ? normalizeOpaqueDelivery(v, { empty: true })
            : normalizeOpaqueDelivery(v, {})
    );
    return {
        ...ctx,
        sources,
        nullifiers: ns,
        remainderCommitments,
        recoveryAmounts,
        expiries,
        spender,
        totalAmount,
        deadline: checkDeadline(c, p.deadline),
        deliveries,
        profile,
        periods: creditPeriods(c.timestamp!),
    };
}
export function creditDrawBaseInputs(
    c: TransactionContext,
    p: CreditDrawParams,
    cs: readonly Delivery[]
) {
    const r = validateCreditDrawRequest(c, p, cs),
        n = r.profile.maxSize,
        h = BigInt(deliveriesHash(cs));
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.spender),
        BigInt(r.nullifiers.length),
        BigInt(r.sources.length),
        ...pad(
            r.sources.map((s) => s.treeId),
            n
        ),
        ...pad(
            r.sources.map((s) => BigInt(s.merkleRoot)),
            n
        ),
        ...pad(r.nullifiers.map(BigInt), n),
        ...pad(r.remainderCommitments.map(BigInt), n),
        ...pad(r.expiries, n),
        r.totalAmount,
        r.deadline,
        h >> 128n,
        h & ((1n << 128n) - 1n),
        ...pad(r.recoveryAmounts.map(BigInt), n),
        r.periods.currentDay,
        r.periods.currentMonth,
    ].map(word);
}
export function validateCancelCreditRequest(c: TransactionContext, p: CancelCreditParams) {
    known(p, [
        "token",
        "source",
        "nullifier",
        "owner",
        "amount",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
    if ((getAddress(p.token) as Hex) !== (getAddress(c.tokenAddress) as Hex))
        throw new Error("request token mismatch");
    const ctx = normalizeContext(c),
        source = normalizeSources([p.source], 1, 1)[0]!,
        nullifier = notes([p.nullifier], "nullifier")[0]!,
        owner = getAddress(p.owner) as Hex,
        amount = uint(p.amount, 126, "amount");
    if (BigInt(owner) === 0n || amount === 0n) throw new Error("owner and amount must be positive");
    const fee = normalizeFee(p);
    if (fee.feeAmount >= amount) throw new Error("fee must leave a positive owner refund");
    return {
        ...ctx,
        ...fee,
        source,
        nullifier,
        owner,
        amount,
        deadline: checkDeadline(c, p.deadline),
    };
}
export function cancelCreditBaseInputs(c: TransactionContext, p: CancelCreditParams) {
    const r = validateCancelCreditRequest(c, p);
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.owner),
        r.source.treeId,
        BigInt(r.source.merkleRoot),
        BigInt(r.nullifier),
        r.amount,
        r.deadline,
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
export function validateTopUpCreditRequest(
    c: TransactionContext,
    p: TopUpCreditParams,
    cs: readonly Delivery[],
    funding: FundingInput = {}
) {
    known(p, ["token", "creation", "creditSource", "creditNullifier", "previousExpiry"]);
    const creation = validateCreateCreditRequest(c, p.creation, cs, funding),
        creditSource = normalizeSources([p.creditSource], 1, 1)[0]!,
        creditNullifier = notes([p.creditNullifier], "creditNullifier")[0]!,
        previousExpiry = uint(p.previousExpiry, 64, "previousExpiry");
    if (previousExpiry === 0n || (c.now !== undefined && previousExpiry <= c.now))
        throw new Error("previous Credit has expired");
    if (creation.expiry < previousExpiry) throw new Error("expiry must not decrease");
    if (creation.nullifiers.includes(creditNullifier))
        throw new Error("duplicate credit and ordinary nullifier");
    return { creation, creditSource, creditNullifier, previousExpiry };
}
export function topUpCreditBaseInputs(
    c: TransactionContext,
    p: TopUpCreditParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = validateTopUpCreditRequest(c, p, cs, f);
    return [
        ...createCreditBaseInputs(c, p.creation, cs, f),
        word(r.creditSource.treeId),
        r.creditSource.merkleRoot,
        r.creditNullifier,
        word(r.previousExpiry),
    ];
}
const cancelTuple = [
    "(address token,(uint256 treeId,bytes32 merkleRoot) source,bytes32 nullifier,address owner,uint256 amount,uint256 deadline,address feeRecipient,uint256 feeAmount)",
][0]!;
const topTuple = [
    "((address token,(uint256 treeId,bytes32 merkleRoot)[] sources,bytes32[] nullifiers,bytes32 creditCommitment,bytes32 changeCommitment,address owner,uint256 expiry,uint256 deadline,address feeRecipient,uint256 feeAmount) creation,(uint256 treeId,bytes32 merkleRoot) creditSource,bytes32 creditNullifier,uint256 previousExpiry)",
][0]!;
const hashContext = {
    chainId: 0n,
    protocolAddress: ZERO_ADDRESS,
    tokenAddress: ZERO_ADDRESS,
};
export function cancelCreditRequestHash(p: CancelCreditParams) {
    validateCancelCreditRequest({ ...hashContext, tokenAddress: p.token }, p);
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [{ type: "bytes32" }, cancelTuple].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiCancelCredit")),
                { ...p, ...normalizeFee(p) },
            ]
        ) as Hex
    ) as Hex;
}
export function topUpCreditRequestHash(
    p: TopUpCreditParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = validateTopUpCreditRequest(
        { ...hashContext, tokenAddress: p.creation.token },
        p,
        cs,
        f
    );
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [
                { type: "bytes32" },
                topTuple,
                { type: "bytes32" },
                { type: "address" },
                { type: "uint256" },
            ].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiTopUpCredit")),
                { ...p, creation: { ...p.creation, ...normalizeFee(p.creation) } },
                deliveriesHash(cs),
                r.creation.funding.payer,
                r.creation.funding.amount,
            ]
        ) as Hex
    ) as Hex;
}
function authorize(
    c: TransactionContext,
    operation: WalletOperation,
    capacity: number,
    words: readonly Hex[]
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation,
        capacity,
        words: words.map(BigInt),
    });
}
function appendDigest(
    c: TransactionContext,
    operation: WalletOperation,
    capacity: number,
    words: readonly Hex[]
) {
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
            operation,
            capacity,
            words: words.map(BigInt),
        })
    );
    return [...words, word(digest >> 128n), word(digest & ((1n << 128n) - 1n))];
}
export function encodeCancelCreditTypedData(c: TransactionContext, p: CancelCreditParams) {
    return authorize(c, "cancel-credit", 1, cancelCreditBaseInputs(c, p));
}
export function encodeTopUpCreditTypedData(
    c: TransactionContext,
    p: TopUpCreditParams,
    deliveries: readonly Delivery[],
    funding: FundingInput = {}
) {
    return authorize(c, "top-up-credit", 10, topUpCreditBaseInputs(c, p, deliveries, funding));
}
export function encodeCreditDrawTypedData(
    c: TransactionContext,
    p: CreditDrawParams,
    deliveries: readonly Delivery[]
) {
    return authorize(
        c,
        "credit-draw",
        selectCreditDrawCircuit(p.nullifiers.length).maxSize,
        creditDrawBaseInputs(c, p, deliveries)
    );
}
export function creditDrawPublicInputs(
    c: TransactionContext,
    p: CreditDrawParams,
    deliveries: readonly Delivery[]
) {
    return appendDigest(
        c,
        "credit-draw",
        selectCreditDrawCircuit(p.nullifiers.length).maxSize,
        creditDrawBaseInputs(c, p, deliveries)
    );
}
export function cancelCreditPublicInputs(c: TransactionContext, p: CancelCreditParams) {
    return appendDigest(c, "cancel-credit", 1, cancelCreditBaseInputs(c, p));
}
export function topUpCreditPublicInputs(
    c: TransactionContext,
    p: TopUpCreditParams,
    deliveries: readonly Delivery[],
    funding: FundingInput = {}
) {
    return appendDigest(c, "top-up-credit", 10, topUpCreditBaseInputs(c, p, deliveries, funding));
}
export function encodeTopUpCreditFundingTypedData(
    c: TransactionContext,
    p: TopUpCreditParams,
    cs: readonly Delivery[],
    f: FundingInput
) {
    const r = validateTopUpCreditRequest(c, p, cs, f),
        funding = r.creation.funding;
    if (funding.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: topUpCreditRequestHash(p, cs, f),
            payer: funding.payer,
            amount: funding.amount,
            sigNonce: funding.sigNonce,
            deadline: funding.deadline,
        },
    };
}
export interface BuildCreditDrawCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: CreditDrawParams;
    deliveries: readonly Delivery[];
}
export function buildCreditDrawCalldata(p: BuildCreditDrawCalldataParams) {
    validateCreditDrawRequest(p.context, p.params, p.deliveries);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("creditDraw", [
            encodeCreditProof(p.proof),
            p.params,
            p.deliveries,
        ]) as Hex,
        nullifiers: p.params.nullifiers,
        totalAmount: p.params.totalAmount,
    };
}
export interface BuildCancelCreditCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: CancelCreditParams;
}
export function buildCancelCreditCalldata(p: BuildCancelCreditCalldataParams) {
    validateCancelCreditRequest(p.context, p.params);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("cancelCredit", [
            encodeCreditProof(p.proof),
            { ...p.params, ...normalizeFee(p.params) },
        ]) as Hex,
    };
}
export interface BuildTopUpCreditCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: TopUpCreditParams;
    deliveries: readonly Delivery[];
    funding?: FundingInput;
    caller?: Address;
}
export function buildTopUpCreditCalldata(p: BuildTopUpCreditCalldataParams) {
    const r = validateTopUpCreditRequest(p.context, p.params, p.deliveries, p.funding);
    validateFundingSubmission(r.creation.funding, p.caller, p.context.now);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("topUpCredit", [
            encodeCreditProof(p.proof),
            { ...p.params, creation: { ...p.params.creation, ...normalizeFee(p.params.creation) } },
            p.deliveries,
            r.creation.funding,
        ]) as Hex,
        approveAmount: r.creation.funding.amount,
    };
}
