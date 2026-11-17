import { computeNoteCommitment } from "@invisi-labs/primitives";
import { AbiCoder, getAddress, Interface, keccak256, ParamType } from "ethers";
import type { Address, Hex } from "../contracts/index";
import {
    invisiCoreAbi,
    type Delivery,
    type ShieldOutput,
    type ShieldParams,
} from "../contracts/index";
import { normalizeFee } from "../fees/fee";
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
    notes,
    uint,
    validateFundingSubmission,
    type FundingInput,
    type TransactionContext,
} from "../validation";

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
    known(p.params, ["token", "noteCommitments", "deadline", "feeRecipient", "feeAmount"]);
    checkDeadline(p.context, p.params.deadline);
    const outputs = dense(p.outputs, "outputs"),
        commitments = notes(p.params.noteCommitments, "noteCommitments"),
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
        normalizeOpaqueDelivery(cs[i]!, { allowEmpty: true });
        if (
            (await computeNoteCommitment(
                p.context.chainId,
                BigInt(p.context.protocolAddress),
                o.identity,
                BigInt(p.context.tokenAddress),
                o.amount
            )) !== commitments[i]
        )
            throw new Error("output commitment mismatch");
        total += o.amount;
    }
    if (total + normalizeFee(p.params).feeAmount !== f.amount)
        throw new Error("funding must equal output total plus fee");
    return f;
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
        data: new Interface(invisiCoreAbi).encodeFunctionData("shield", [
            { ...p.params, ...normalizeFee(p.params) },
            p.outputs,
            p.deliveries,
            f,
        ]) as Hex,
        approveAmount: f.amount,
    };
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
                "(address token,bytes32[] noteCommitments,uint256 deadline,address feeRecipient,uint256 feeAmount)",
                "bytes32",
                "bytes32",
            ].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiShield")),
                { ...params, ...normalizeFee(params) },
                outputHash,
                deliveriesHash(cs),
            ]
        ) as Hex
    ) as Hex;
}
