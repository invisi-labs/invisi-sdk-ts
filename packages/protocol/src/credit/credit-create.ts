import { normalizeFee } from "../fees/fee";
import { AbiCoder, Interface, getAddress, isHexString, dataLength } from "ethers";
import {
    computeWalletAuthorizationDigest,
    creditPeriods,
    walletAuthorizationTypedData,
} from "@invisi-labs/primitives";
import {
    invisiCoreAbi,
    type Hex,
    type CreditCreationParams,
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
    "hasInitialPayment",
    "totalAmount",
    "noteCommitment",
] as const;
export function validateCreateCreditRequest(
    c: TransactionContext,
    p: CreditCreationParams,
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
    const initialPayment = p.hasInitialPayment === true;
    const totalAmount = uint(p.totalAmount ?? 0n, 126, "totalAmount");
    const noteCommitment = word(field(p.noteCommitment ?? word(0n)));
    const fee = normalizeFee(p);
    if (p.hasInitialPayment !== undefined && typeof p.hasInitialPayment !== "boolean")
        throw Error("invalid initial payment mode");
    if (
        !initialPayment &&
        (totalAmount !== 0n ||
            BigInt(noteCommitment) !== 0n ||
            (p.hasInitialPayment === undefined &&
                (p.totalAmount !== undefined || p.noteCommitment !== undefined)))
    )
        throw Error("initial payment fields are not valid for pure or legacy creation");
    if (
        initialPayment &&
        (totalAmount <= fee.feeAmount || !BigInt(noteCommitment) || c.timestamp === undefined)
    )
        throw Error(
            "initial payment requires a positive net amount, a Note commitment and a timestamp"
        );
    if (initialPayment && noteCommitment === creditCommitment)
        throw Error("duplicate output commitment");
    if (dense(deliveries, "deliveries").length !== (initialPayment ? 3 : 2))
        throw Error("deliveries count mismatch");
    return {
        ...ctx,
        ...fee,
        totalAmount,
        noteCommitment,
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
    p: CreditCreationParams,
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
        ...(p.hasInitialPayment
            ? [
                  BigInt(r.noteCommitment),
                  r.totalAmount,
                  creditPeriods(c.timestamp!).currentDay,
                  creditPeriods(c.timestamp!).currentMonth,
              ]
            : []),
    ].map(word);
}
export function authorizedCreditInputs(
    c: TransactionContext,
    operation: "create-credit" | "create-credit-initial-payment" | "credit-draw" | "update-credit",
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
export function createCreditOperation(p: CreditCreationParams) {
    return p.hasInitialPayment ? "create-credit-initial-payment" : "create-credit";
}
export function createCreditPublicInputs(
    c: TransactionContext,
    p: CreditCreationParams,
    d: readonly Delivery[]
) {
    return authorizedCreditInputs(c, createCreditOperation(p), 1, createCreditBaseInputs(c, p, d));
}
export function encodeCreateCreditTypedData(
    c: TransactionContext,
    p: CreditCreationParams,
    d: readonly Delivery[]
) {
    return walletAuthorizationTypedData({
        context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
        operation: createCreditOperation(p),
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
    params: CreditCreationParams;
    deliveries: readonly Delivery[];
}
export const legacyCreateCreditAbi = [
    "function createCredit(bytes proof,(address token,address owner,uint64 revocationShard,uint16 revocationSlot,bytes32 creditCommitment,uint256 deadline,address feeRecipient,uint256 feeAmount) p,(bytes ciphertext,bytes clue)[] deliveries)",
] as const;
const legacyCreateCredit = new Interface(legacyCreateCreditAbi);
const currentCreateCredit = new Interface(invisiCoreAbi);
export function encodeCreateCreditCall(
    p: CreditCreationParams,
    encodedProof: Hex,
    d: readonly Delivery[]
) {
    const args = { ...p, ...normalizeFee(p) };
    return (
        p.hasInitialPayment === undefined ? legacyCreateCredit : currentCreateCredit
    ).encodeFunctionData("createCredit", [
        encodedProof,
        p.hasInitialPayment === undefined
            ? args
            : {
                  ...args,
                  totalAmount: p.totalAmount ?? 0n,
                  noteCommitment: p.noteCommitment ?? word(0n),
              },
        d,
    ]) as Hex;
}
export function buildCreateCreditCalldata(p: BuildCreateCreditCalldataParams) {
    const r = validateCreateCreditRequest(p.context, p.params, p.deliveries);
    const amount = p.params.hasInitialPayment ? r.totalAmount : r.feeAmount;
    return {
        data: encodeCreateCreditCall(p.params, encodeCreditProof(p.proof), r.deliveries),
        approveAmount: amount,
        approvalRequirements: amount ? [{ token: r.tokenAddress, payer: r.owner, amount }] : [],
    };
}
