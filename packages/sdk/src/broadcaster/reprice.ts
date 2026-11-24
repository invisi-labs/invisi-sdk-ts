import {
    ReceivingAddress,
    computeNoteCommitment,
    createClue,
    encryptPrivateTransferNote,
    applyCreditDrawUsage,
} from "@invisi-labs/primitives";
import {
    createCreditPublicInputs,
    creditDrawPublicInputs,
    normalizeFee,
    normalizeFunding,
    normalizeTransactRequest,
    transactUserPublicInputs,
    updateCreditPublicInputs,
} from "@invisi-labs/protocol";
import { WitnessBuilder } from "@invisi-labs/prover";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { hexlify } from "ethers";
import { InvisiError } from "../errors";
import type { OperationPlan, PreparedOutput } from "../transactions/operation-types";
import type { BroadcasterFeeSource } from "./broadcaster-preparation";

export function needsReprepare(reason: string): never {
    throw new InvisiError("NEEDS_REPREPARE", reason);
}

async function resize(output: PreparedOutput, amount: bigint): Promise<PreparedOutput> {
    if (amount <= 0n || amount >= 1n << 128n)
        throw Error("adjusted Note must be a positive uint128");
    if (output.amount === amount) return output;
    const address =
        output.recipient.type === "evm"
            ? (output.resolvedAddress ?? output.address)
            : output.address;
    if (!output.note || ReceivingAddress.parse(address).kind !== "long")
        return needsReprepare(
            "Prepare again with the resolved receiving keys for the fee-adjusted output"
        );
    const recipient = ReceivingAddress.parse(address);
    if (BigInt(recipient.ownerAddress) !== BigInt(output.note.ownerAddress))
        throw Error("Fee-adjusted output receiving keys changed owner");
    const { viewingPublicKey, clueKey } = recipient.getReceivingKeys();
    const context = output.context;
    const note = { ...output.note, amount };
    const commitment = await computeNoteCommitment(
        context.chainId,
        BigInt(context.protocolAddress),
        output.identity,
        BigInt(context.tokenAddress),
        amount
    );
    const delivery = {
        ciphertext: hexlify(
            await encryptPrivateTransferNote(viewingPublicKey, note, {
                chainId: context.chainId,
                protocolAddress: BigInt(context.protocolAddress),
                outputCommitment: commitment,
            })
        ) as Hex,
        clue: hexlify(createClue(clueKey)) as Hex,
    };
    return { ...output, note, amount, commitment, delivery };
}

/** Fee-only construction from the original frozen terms. No reader, selector, or signer. */
export async function repricePlan(
    original: OperationPlan,
    recipient: Hex,
    amount: bigint,
    source?: BroadcasterFeeSource,
    permit?: OperationPlan["funding"]["permit"]
): Promise<OperationPlan> {
    const plan = structuredClone(original);
    const intent = plan.intent!;
    const fee = normalizeFee({ feeRecipient: recipient, feeAmount: amount });
    if (intent.kind === "shield" || intent.kind === "transfer") {
        const fixed = plan.outputs.filter((output) => !output.change);
        const payments = fixed.reduce((total, output) => total + output.amount, 0n);
        const publicFunds = intent.options.funding;
        if (!!publicFunds !== (plan.fundingMode !== "none"))
            needsReprepare("Prepare again with complete funding terms");
        if (publicFunds) {
            if (
                plan.fundingMode !== "signature" ||
                plan.funding.sigNonce === undefined ||
                !plan.funding.deadline
            )
                needsReprepare("Prepare with signature funding to select its nonce and deadline");
            let gross = publicFunds.amount;
            if (source === "public-funding") {
                // A prepared public fee is part of its original gross amount.
                const budget = intent.options.fee?.amount ?? 0n;
                const businessDeposit =
                    intent.kind === "shield" ? payments : gross - (budget > gross ? gross : budget);
                gross = businessDeposit + amount;
            }
            plan.funding = normalizeFunding({
                ...plan.funding,
                amount: gross,
                ...(permit ? { permit } : {}),
            });
        }
        if (plan.shieldParams) {
            Object.assign(plan.shieldParams, fee);
            return plan;
        }
        const params = plan.params!;
        const selected = plan.inputs.reduce((total, input) => total + input.note.amount, 0n);
        const payout =
            source === "payout"
                ? selected - amount
                : intent.kind === "transfer"
                  ? (intent.options.withdrawal?.amount ?? 0n)
                  : 0n;
        const change = selected + (plan.funding.amount ?? 0n) - payments - payout - amount;
        if (change < 0n)
            needsReprepare(
                "Fee exceeds prepared private funds; prepare again with a sufficient fee budget"
            );
        if (payments + payout + amount >= 1n << 135n)
            throw Error("transaction sum exceeds uint135");
        if (source === "private-inputs" && !plan.inputs.length)
            needsReprepare(
                "Private fee requires prepared private inputs; prepare again with a fee budget"
            );
        const changeOutput = plan.changeTemplate ?? plan.outputs.find((output) => output.change);
        if (changeOutput && !plan.changeTemplate) plan.changeTemplate = changeOutput;
        plan.outputs = fixed;
        if (change > 0n) {
            if (!changeOutput)
                needsReprepare("Prepare again with a change destination and fee budget");
            plan.outputs.push(await resize(changeOutput, change));
        }
        Object.assign(params, fee, {
            withdrawalAmount: payout,
            noteCommitments: plan.outputs.map((output) => output.commitment),
        });
        const deliveries = plan.outputs.map((output) => output.delivery);
        const { capacity } = normalizeTransactRequest(
            plan.context,
            params,
            deliveries,
            plan.funding
        );
        plan.capacity = capacity;
        plan.statement = WitnessBuilder.statement(
            `transact_user_slots${capacity}`,
            transactUserPublicInputs(plan.context, params, deliveries, plan.funding),
            "evm"
        );
        return plan;
    }
    const credit = plan.credit!;
    if (credit.revocation) {
        if (!intent.options.fee?.amount)
            needsReprepare(
                "Prepare paid revocation with a positive fee to validate the token contract"
            );
        Object.assign(credit.revocation, fee);
        return plan;
    }
    const stmt = plan.statement!;
    if (credit.update) {
        Object.assign(credit.update, fee);
        plan.statement = WitnessBuilder.statement(
            stmt.circuitName,
            updateCreditPublicInputs(plan.context, credit.update, credit.deliveries),
            stmt.target
        );
    } else if (credit.draw) {
        Object.assign(credit.draw, fee);
        const output = await resize(plan.outputs[0]!, credit.draw.totalAmount - amount);
        plan.outputs = [output];
        credit.draw.noteCommitment = output.commitment;
        credit.deliveries = [...credit.outputs.flatMap((c) => c.deliveries), output.delivery];
        plan.statement = WitnessBuilder.statement(
            stmt.circuitName,
            creditDrawPublicInputs(plan.context, credit.draw, credit.deliveries),
            stmt.target
        );
    } else {
        const creation = credit.creation!;
        Object.assign(creation, fee);
        if (creation.hasInitialPayment && intent.kind === "create-credit") {
            const payment = intent.options.initialPayment!;
            const gross =
                payment.netAmount === undefined ? payment.amount : payment.netAmount + amount;
            if (gross >= 1n << 126n) throw Error("initial payment gross must be uint126");
            const output = await resize(plan.outputs[0]!, gross - amount);
            if (gross !== creation.totalAmount) {
                const state = credit.outputs[0]!.state;
                if (credit.initialPaymentInitialAvailableCredit === undefined)
                    needsReprepare("Prepare Credit again with the original initial balance");
                const initial = {
                    ...state.note,
                    availableCredit: credit.initialPaymentInitialAvailableCredit,
                    lastDay: 0n,
                    dailySpent: 0n,
                    lastMonth: 0n,
                    monthlySpent: 0n,
                    totalSpent: 0n,
                };
                const usage = applyCreditDrawUsage(
                    initial,
                    gross,
                    plan.context.timestamp ?? plan.preparedAt.timestamp
                );
                const { sealCreditOutput } = await import("../credit/seal");
                credit.outputs = [
                    await sealCreditOutput(
                        { ...state, note: { ...initial, ...usage } },
                        plan.context
                    ),
                ];
                creation.creditCommitment = credit.outputs[0]!.commitment;
            }
            creation.totalAmount = gross;
            creation.noteCommitment = output.commitment;
            plan.outputs = [output];
            credit.deliveries = [...credit.outputs[0]!.deliveries, output.delivery];
        }
        plan.statement = WitnessBuilder.statement(
            stmt.circuitName,
            createCreditPublicInputs(plan.context, creation, credit.deliveries),
            stmt.target
        );
    }
    return plan;
}
