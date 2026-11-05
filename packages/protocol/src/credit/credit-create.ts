import {
    AbiCoder,
    dataLength,
    getAddress,
    Interface,
    isHexString,
    keccak256,
    ParamType,
} from "ethers";
import type { Address, Hex } from "../contracts/index";
import { normalizeFee } from "../fees/fee";

import { computeWalletAuthorizationDigest, walletAuthorizationTypedData } from "@invisi-labs/core";
import { invisiProtocolAbi, type CreateCreditParams, type Delivery } from "../contracts/index";
import {
    checkDeadline,
    deliveriesHash,
    dense,
    field,
    fundingFields,
    getEIP712Domain,
    known,
    normalizeContext,
    normalizeFunding,
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
} from "../validation";
const creationTuple = [
    "(address token,(uint256 treeId,bytes32 merkleRoot)[] sources,bytes32[] nullifiers,bytes32 creditCommitment,bytes32 changeCommitment,address owner,uint256 expiry,uint256 deadline,address feeRecipient,uint256 feeAmount)",
][0]!;
export const CREATE_CREDIT_FIELDS = [
    "token",
    "sources",
    "nullifiers",
    "creditCommitment",
    "changeCommitment",
    "owner",
    "expiry",
    "deadline",
    "feeRecipient",
    "feeAmount",
] as const;
/** Public checks cannot establish ownership or conservation: those are enforced by the proof. */
export function validateCreateCreditRequest(
    c: TransactionContext,
    p: CreateCreditParams,
    cs: readonly Delivery[],
    funding: FundingInput = {}
) {
    known(p, CREATE_CREDIT_FIELDS);
    if ((getAddress(p.token) as Hex) !== (getAddress(c.tokenAddress) as Hex))
        throw new Error("request token mismatch");
    const ctx = normalizeContext(c),
        ns = notes(p.nullifiers, "nullifiers"),
        sources = normalizeSources(p.sources, ns.length, 10),
        creditCommitment = word(field(p.creditCommitment)),
        changeCommitment = word(field(p.changeCommitment)),
        owner = getAddress(p.owner) as Hex,
        expiry = uint(p.expiry, 64, "expiry"),
        deadline = checkDeadline(c, p.deadline),
        f = normalizeFunding(funding);
    if (BigInt(creditCommitment) === 0n || creditCommitment === changeCommitment)
        throw new Error("zero or duplicate commitment");
    if (BigInt(owner) === 0n || expiry === 0n || (c.now !== undefined && expiry <= c.now))
        throw new Error("owner must be nonzero and expiry future");
    if (dense(cs, "deliveries").length !== 3) throw new Error("deliveries count mismatch");
    const deliveries = cs.map((v, i) =>
        normalizeOpaqueDelivery(v, {
            empty: i === 2 && BigInt(changeCommitment) === 0n,
            allowEmpty: i === 2,
        })
    );
    if (ns.length === 0 && f.amount === 0n)
        throw new Error("empty inputs require positive funding");
    return {
        ...ctx,
        ...normalizeFee(p),
        sources,
        nullifiers: ns,
        actualCount: ns.length,
        sourceCount: sources.length,
        creditCommitment,
        changeCommitment,
        owner,
        expiry,
        deadline,
        deliveries,
        funding: f,
    };
}
export function createCreditBaseInputs(
    c: TransactionContext,
    p: CreateCreditParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = validateCreateCreditRequest(c, p, cs, f),
        h = BigInt(deliveriesHash(cs));
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.owner),
        BigInt(r.actualCount),
        BigInt(r.sourceCount),
        ...pad(
            r.sources.map((s) => s.treeId),
            10
        ),
        ...pad(
            r.sources.map((s) => BigInt(s.merkleRoot)),
            10
        ),
        ...pad(r.nullifiers.map(BigInt), 10),
        BigInt(r.creditCommitment),
        BigInt(r.changeCommitment),
        h >> 128n,
        h & ((1n << 128n) - 1n),
        r.expiry,
        r.deadline,
        r.funding.amount,
        BigInt(r.funding.payer),
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
export function createCreditPublicInputs(
    c: TransactionContext,
    p: CreateCreditParams,
    deliveries: readonly Delivery[],
    funding: FundingInput = {}
) {
    const base = createCreditBaseInputs(c, p, deliveries, funding);
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
            operation: "create-credit",
            capacity: 10,
            words: base.map(BigInt),
        })
    );
    return [...base, word(digest >> 128n), word(digest & ((1n << 128n) - 1n))];
}
const hashContext = {
    chainId: 0n,
    protocolAddress: ZERO_ADDRESS,
    tokenAddress: ZERO_ADDRESS,
};
export function createCreditRequestHash(
    p: CreateCreditParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = validateCreateCreditRequest({ ...hashContext, tokenAddress: p.token }, p, cs, f);
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [
                { type: "bytes32" },
                creationTuple,
                { type: "bytes32" },
                { type: "address" },
                { type: "uint256" },
            ].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiCreateCredit")),
                { ...p, ...normalizeFee(p) },
                deliveriesHash(cs),
                r.funding.payer,
                r.funding.amount,
            ]
        ) as Hex
    ) as Hex;
}
export function encodeCreateCreditTypedData(
    c: TransactionContext,
    p: CreateCreditParams,
    deliveries: readonly Delivery[],
    funding: FundingInput = {}
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation: "create-credit",
        capacity: 10,
        words: createCreditBaseInputs(c, p, deliveries, funding).map(BigInt),
    });
}
export function encodeCreateCreditFundingTypedData(
    c: TransactionContext,
    p: CreateCreditParams,
    cs: readonly Delivery[],
    f: FundingInput
) {
    const r = validateCreateCreditRequest(c, p, cs, f);
    if (r.funding.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: createCreditRequestHash(p, cs, f),
            payer: r.funding.payer,
            amount: r.funding.amount,
            sigNonce: r.funding.sigNonce,
            deadline: r.funding.deadline,
        },
    };
}
export interface BuildCreateCreditCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: CreateCreditParams;
    deliveries: readonly Delivery[];
    funding?: FundingInput;
    caller?: Address;
}
export function buildCreateCreditCalldata(p: BuildCreateCreditCalldataParams) {
    const r = validateCreateCreditRequest(p.context, p.params, p.deliveries, p.funding);
    validateFundingSubmission(r.funding, p.caller, p.context.now);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("createCredit", [
            encodeCreditProof(p.proof),
            { ...p.params, ...normalizeFee(p.params) },
            p.deliveries,
            r.funding,
        ]) as Hex,
        approveAmount: r.funding.amount,
    };
}

/** Frame a raw direct proof from the proving backend for the Credit verifier adapter. */
export function encodeCreditProof(proof: Hex): Hex {
    if (!isHexString(proof) || !/^0x(?:[a-fA-F0-9]{2})*$/.test(proof) || dataLength(proof) === 0)
        throw new Error("empty or malformed Credit proof");
    return AbiCoder.defaultAbiCoder().encode(
        ["uint8", "bytes"].map((parameter) => ParamType.from(parameter)),
        [0, proof]
    ) as Hex;
}
