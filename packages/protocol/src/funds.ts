import type { Address, Hex } from "./contracts";
import { AbiCoder, getAddress, Interface, keccak256, ParamType, TypedDataEncoder } from "ethers";

import {
    invisiProtocolAbi,
    type CrossTreeTransactParams,
    type Delivery,
    type ShieldOutput,
    type ShieldParams,
    type TransactRequest,
} from "./contracts";
import { computeNoteCommitment, walletAuthorizationTypedData } from "@invisi-labs/core";
import {
    checkDeadline,
    deliveriesHash,
    dense,
    field,
    fundingFields,
    getEIP712Domain,
    known,
    normalizeContext,
    normalizeDelivery,
    normalizeFunding,
    normalizeSources,
    notes,
    pad,
    uint,
    validateFundingSubmission,
    word,
    type DeploymentContext,
    type FundingInput,
    type TransactionContext,
} from "./validation";
export const TRANSACT_CAPACITIES = [14, 56, 112, 168] as const;
export type TransactCapacity = (typeof TRANSACT_CAPACITIES)[number];
export function selectTransactCapacity(inputs: number, outputs: number): TransactCapacity {
    if (
        !Number.isInteger(inputs) ||
        !Number.isInteger(outputs) ||
        inputs < 0 ||
        outputs < 0 ||
        inputs + outputs < 1 ||
        (inputs === 0 && outputs < 2) ||
        inputs + outputs > 168
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
    ]);
    const ns = notes(p.nullifiers, "nullifiers"),
        os = notes(p.outputCommitments, "outputCommitments"),
        capacity = selectTransactCapacity(ns.length, os.length);
    const sources = normalizeSources(p.sources, ns.length, capacity),
        deliveries = dense(cs, "deliveries").map((v) => normalizeDelivery(v));
    if (deliveries.length !== os.length) throw new Error("deliveries count mismatch");
    const withdrawalAmount = uint(p.withdrawalAmount, 128, "withdrawalAmount"),
        withdrawalAddress = getAddress(p.withdrawalAddress) as Hex,
        f = normalizeFunding(funding);
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
    ].map(word);
}
export function encodeTransactTypedData(
    c: TransactionContext,
    p: TransactRequestParams,
    deliveries: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = normalizeTransactRequest(c, p, deliveries, f);
    return walletAuthorizationTypedData({
        context: { chainId: r.chainId, protocolAddress: BigInt(r.protocolAddress) },
        operation: "transact",
        capacity: r.capacity,
        words: transactPublicInputs(c, p, deliveries, f).map(BigInt),
    });
}
const singleTuple = [
    "(address token,bytes32 merkleRoot,bytes32[] nullifiers,bytes32[] outputCommitments,uint256 inputTreeId,address withdrawalAddress,uint256 withdrawalAmount,uint256 deadline)",
][0]!;
const crossTuple = [
    "(address token,(uint256 treeId,bytes32 merkleRoot)[] sources,bytes32[] nullifiers,bytes32[] outputCommitments,address withdrawalAddress,uint256 withdrawalAmount,uint256 deadline)",
][0]!;
export function transactFundingRequestHash(
    proof: Hex,
    p: TransactRequestParams,
    cs: readonly Delivery[]
) {
    const single = {
        token: p.token,
        merkleRoot: p.sources[0]?.merkleRoot ?? word(0n),
        nullifiers: p.nullifiers,
        outputCommitments: p.outputCommitments,
        inputTreeId: p.sources[0]?.treeId ?? 0n,
        withdrawalAddress: p.withdrawalAddress,
        withdrawalAmount: p.withdrawalAmount,
        deadline: p.deadline,
    };
    return p.sources.length > 1
        ? (keccak256(
              AbiCoder.defaultAbiCoder().encode(
                  [{ type: "bytes32" }, { type: "bytes32" }, crossTuple, { type: "bytes32" }].map(
                      (parameter) => ParamType.from(parameter)
                  ),
                  [
                      keccak256(new TextEncoder().encode("InvisiCrossTreeTransact")),
                      keccak256(proof),
                      p,
                      deliveriesHash(cs),
                  ]
              ) as Hex
          ) as Hex)
        : (keccak256(
              AbiCoder.defaultAbiCoder().encode(
                  [{ type: "bytes32" }, singleTuple, { type: "bytes32" }].map((parameter) =>
                      ParamType.from(parameter)
                  ),
                  [keccak256(proof), single, deliveriesHash(cs)]
              ) as Hex
          ) as Hex);
}
export function encodeTransactFundingTypedData(
    c: TransactionContext,
    proof: Hex,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    funding: FundingInput
) {
    normalizeTransactRequest(c, p, cs, funding);
    const f = normalizeFunding(funding);
    if (f.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: transactFundingRequestHash(proof, p, cs),
            payer: f.payer,
            amount: f.amount,
            sigNonce: f.sigNonce,
            deadline: f.deadline,
        },
    };
}
export interface BuildTransactCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: TransactRequestParams;
    deliveries: readonly Delivery[];
    funding?: FundingInput;
    caller?: Address;
}
export function buildTransactCalldata(p: BuildTransactCalldataParams) {
    const r = normalizeTransactRequest(p.context, p.params, p.deliveries, p.funding);
    validateFundingSubmission(r.funding, p.caller, p.context.now);
    const request: TransactRequest = {
        params: {
            token: r.tokenAddress,
            sources: r.sources,
            nullifiers: r.nullifiers,
            outputCommitments: r.outputCommitments,
            withdrawalAddress: r.withdrawalAddress,
            withdrawalAmount: r.withdrawalAmount,
            deadline: r.deadline,
        },
        deliveries: p.deliveries,
        funding: r.funding,
    };
    const abi = invisiProtocolAbi.filter(
        (item) =>
            item.type === "function" &&
            item.name === "transact" &&
            item.inputs.length === 2 &&
            item.inputs[1]?.type === "tuple"
    );
    const data = new Interface(abi).encodeFunctionData("transact", [p.proof, request]) as Hex;
    return { data, capacity: r.capacity, approveAmount: r.depositAmount };
}
export interface BuildTransactAggregateCalldataParams {
    context: DeploymentContext & { now?: bigint };
    proof: Hex;
    requests: readonly TransactRequest[];
    caller?: Address;
}
export function buildTransactAggregateCalldata(p: BuildTransactAggregateCalldataParams) {
    if (![4, 8, 12].includes(dense(p.requests, "requests").length))
        throw new Error("aggregate requires 4, 8 or 12 requests");
    for (const request of p.requests) {
        const r = normalizeTransactRequest(
            { ...p.context, tokenAddress: request.params.token },
            request.params,
            request.deliveries,
            request.funding
        );
        if (r.capacity !== 14) throw new Error("aggregate supports only capacity 14");
        validateFundingSubmission(r.funding, p.caller, p.context.now);
    }
    return {
        data: new Interface(
            invisiProtocolAbi.filter(
                (item) =>
                    item.type === "function" &&
                    item.name === "transact" &&
                    item.inputs[1]?.type === "tuple[]"
            )
        ).encodeFunctionData("transact", [p.proof, p.requests]) as Hex,
        capacity: 14 as const,
    };
}
export interface BuildShieldCalldataParams {
    context: TransactionContext;
    params: ShieldParams;
    outputs: readonly ShieldOutput[];
    deliveries: readonly Delivery[];
    funding: FundingInput;
    caller?: Address;
}
export async function validateShieldRequest(p: BuildShieldCalldataParams) {
    normalizeContext(p.context);
    if ((getAddress(p.params.token) as Hex) !== (getAddress(p.context.tokenAddress) as Hex))
        throw new Error("request token mismatch");
    known(p.params, ["token", "outputCommitments", "deadline"]);
    checkDeadline(p.context, p.params.deadline);
    const outputs = dense(p.outputs, "outputs"),
        commitments = notes(p.params.outputCommitments, "outputCommitments"),
        cs = dense(p.deliveries, "deliveries"),
        f = normalizeFunding(p.funding);
    if (
        outputs.length < 1 ||
        outputs.length > 10 ||
        commitments.length !== outputs.length ||
        cs.length !== outputs.length
    )
        throw new Error("shield requires 1..10 outputs and matching deliveries");
    let total = 0n;
    for (const [i, o] of outputs.entries()) {
        known(o, ["identity", "amount"], "output");
        uint(o.amount, 128, "amount");
        if (o.amount === 0n) throw new Error("amount must be positive");
        field(o.identity);
        normalizeDelivery(cs[i]!);
        if (
            (await computeNoteCommitment(
                p.context.chainId,
                o.identity,
                BigInt(p.context.tokenAddress),
                o.amount
            )) !== commitments[i]
        )
            throw new Error("output commitment mismatch");
        total += o.amount;
    }
    if (total !== f.amount) throw new Error("funding must equal output total");
    return f;
}
export function shieldFundingRequestHash(
    params: ShieldParams,
    outputs: readonly ShieldOutput[],
    cs: readonly Delivery[]
) {
    const outputHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["(bytes32 identity,uint256 amount)[]"].map((parameter) => ParamType.from(parameter)),
            [outputs]
        ) as Hex
    ) as Hex;
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [
                "bytes32",
                "(address token,bytes32[] outputCommitments,uint256 deadline)",
                "bytes32",
                "bytes32",
            ].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiShield")),
                params,
                outputHash,
                deliveriesHash(cs),
            ]
        ) as Hex
    ) as Hex;
}
export async function encodeShieldFundingTypedData(p: BuildShieldCalldataParams) {
    const f = await validateShieldRequest(p);
    return {
        domain: getEIP712Domain(p.context),
        primaryType: "FundShield" as const,
        types: { FundShield: fundingFields },
        message: {
            requestHash: shieldFundingRequestHash(p.params, p.outputs, p.deliveries),
            payer: f.payer,
            amount: f.amount,
            sigNonce: f.sigNonce,
            deadline: f.deadline,
        },
    };
}
export async function buildShieldCalldata(p: BuildShieldCalldataParams) {
    const f = await validateShieldRequest(p);
    validateFundingSubmission(f, p.caller, p.context.now);
    return {
        data: new Interface(invisiProtocolAbi).encodeFunctionData("shield", [
            p.params,
            p.outputs,
            p.deliveries,
            f,
        ]) as Hex,
        approveAmount: f.amount,
    };
}

/** Full active user-circuit public inputs: business statement followed by EIP-712 digest limbs. */
export function transactUserPublicInputs(
    c: TransactionContext,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const words = transactPublicInputs(c, p, cs, f),
        digest = BigInt(
            ((typed) =>
                TypedDataEncoder.hash(
                    typed.domain,
                    Object.fromEntries(
                        Object.entries(typed.types).map(([name, fields]) => [
                            name,
                            [...(fields as readonly { name: string; type: string }[])],
                        ])
                    ),
                    typed.message
                ))(encodeTransactTypedData(c, p, cs, f))
        );
    return [...words, word(digest >> 128n), word(digest & ((1n << 128n) - 1n))];
}
export type AggregateMemberInput = Pick<TransactRequest, "params" | "deliveries"> & {
    funding?: FundingInput;
};
/** Atomic aggregate funding binds the member statement rather than the aggregate proof bytes. */
export function aggregateMemberRequestHash(c: TransactionContext, r: AggregateMemberInput) {
    const capacity = selectTransactCapacity(
        r.params.nullifiers.length,
        r.params.outputCommitments.length
    );
    if (capacity !== 14) throw new Error("aggregate supports only capacity 14");
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "uint256", "bytes32[]"].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiAtomicBatchMemberV1")),
                BigInt(capacity),
                transactPublicInputs(c, r.params, r.deliveries, r.funding),
            ]
        ) as Hex
    ) as Hex;
}
/** Router adapter business words (56 per member), not the aggregate circuit statement. */
export function aggregatePublicInputs(
    c: TransactionContext,
    requests: readonly AggregateMemberInput[]
) {
    if (![4, 8, 12].includes(dense(requests, "requests").length))
        throw new Error("aggregate requires 4, 8 or 12 requests");
    return requests.flatMap((r) => {
        const context = { ...c, tokenAddress: r.params.token };
        aggregateMemberRequestHash(context, r);
        return [word(14n), ...transactPublicInputs(context, r.params, r.deliveries, r.funding)];
    });
}
export function encodeAggregateFundingTypedData(c: TransactionContext, r: AggregateMemberInput) {
    const f = normalizeFunding(r.funding);
    if (f.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: aggregateMemberRequestHash(c, r),
            payer: f.payer,
            amount: f.amount,
            sigNonce: f.sigNonce,
            deadline: f.deadline,
        },
    };
}
