import { normalizeFee } from "../fees/fee";
import { AbiCoder, Interface, getAddress, isHexString, dataLength } from "ethers";
import {
    computeWalletAuthorizationDigest,
    walletAuthorizationTypedData,
} from "@invisi-labs/primitives";
import {
    invisiProtocolAbi,
    type Hex,
    type CreateCreditParams,
    type Delivery,
} from "../contracts/index";
import {
    known,
    normalizeContext,
    field,
    word,
    uint,
    checkDeadline,
    dense,
    normalizeOpaqueDelivery,
    deliveriesHash,
    type TransactionContext,
} from "../validation";
export const CREATE_CREDIT_FIELDS = [
    "token",
    "owner",
    "revocationShard",
    "revocationSlot",
    "creditCommitment",
    "deadline",
    "feeRecipient",
    "feeAmount",
] as const;
export function validateCreateCreditRequest(
    c: TransactionContext,
    p: CreateCreditParams,
    deliveries: readonly Delivery[]
) {
    known(p, CREATE_CREDIT_FIELDS);
    const ctx = normalizeContext(c),
        owner = getAddress(p.owner) as Hex,
        revocationShard = uint(p.revocationShard, 64, "revocationShard"),
        revocationSlot = uint(p.revocationSlot, 16, "revocationSlot"),
        creditCommitment = word(field(p.creditCommitment));
    if (
        getAddress(p.token) !== ctx.tokenAddress ||
        !BigInt(owner) ||
        !revocationShard ||
        !BigInt(creditCommitment)
    )
        throw Error("invalid Credit authority, token or commitment");
    if (dense(deliveries, "deliveries").length !== 2) throw Error("deliveries count mismatch");
    return {
        ...ctx,
        ...normalizeFee(p),
        owner,
        revocationShard,
        revocationSlot,
        creditCommitment,
        deadline: checkDeadline(c, p.deadline),
        deliveries: deliveries.map((d) => normalizeOpaqueDelivery(d, {})),
    };
}
export function createCreditBaseInputs(
    c: TransactionContext,
    p: CreateCreditParams,
    d: readonly Delivery[]
) {
    const r = validateCreateCreditRequest(c, p, d),
        h = BigInt(deliveriesHash(d));
    return [
        r.chainId,
        BigInt(r.protocolAddress),
        BigInt(r.tokenAddress),
        BigInt(r.owner),
        r.revocationShard,
        r.revocationSlot,
        BigInt(r.creditCommitment),
        r.deadline,
        h >> 128n,
        h & ((1n << 128n) - 1n),
        BigInt(r.feeRecipient),
        r.feeAmount,
    ].map(word);
}
export function authorizedCreditInputs(
    c: TransactionContext,
    operation: "create-credit" | "credit-draw" | "update-credit",
    capacity: number,
    base: readonly Hex[]
) {
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
            operation,
            capacity,
            words: base.map(BigInt),
        })
    );
    return [...base, word(digest >> 128n), word(digest & ((1n << 128n) - 1n))];
}
export function createCreditPublicInputs(
    c: TransactionContext,
    p: CreateCreditParams,
    d: readonly Delivery[]
) {
    return authorizedCreditInputs(c, "create-credit", 1, createCreditBaseInputs(c, p, d));
}
export function encodeCreateCreditTypedData(
    c: TransactionContext,
    p: CreateCreditParams,
    d: readonly Delivery[]
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation: "create-credit",
        capacity: 1,
        words: createCreditBaseInputs(c, p, d).map(BigInt),
    });
}
export function encodeCreditProof(proof: Hex): Hex {
    if (!isHexString(proof) || !dataLength(proof)) throw Error("empty or malformed Credit proof");
    return AbiCoder.defaultAbiCoder().encode(["uint8", "bytes"], [0, proof]) as Hex;
}
export interface BuildCreateCreditCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: CreateCreditParams;
    deliveries: readonly Delivery[];
}
export function buildCreateCreditCalldata(p: BuildCreateCreditCalldataParams) {
    const r = validateCreateCreditRequest(p.context, p.params, p.deliveries);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("createCredit", [
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
