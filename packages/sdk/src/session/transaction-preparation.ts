import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress } from "ethers";
import {
    normalizeTransactRequest,
    transactUserPublicInputs,
    WitnessBuilder,
    ZERO_ADDRESS,
} from "@invisi-labs/protocol";
import type { ProofTarget } from "@invisi-labs/prover";
import {
    positiveAmount,
    positiveOutputAmount,
    Preparation,
    type PreparationFrame,
} from "./prepare-common";
import { CreditPreparation } from "./prepare-credit";
import type {
    CancelCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    PreparationRuntime,
    PaymentOutput,
    ShieldPreparation,
    TopUpCreditPreparation,
    TransferPreparation,
} from "./operation-types";

/** Shared preparation engine for managed sessions and explicitly supplied inputs. */
export class TransactionPreparation<Result> {
    constructor(readonly context: PreparationRuntime<Result>) {}
    private runtime(tokenAddress: Hex): PreparationRuntime<Result> {
        if (
            getAddress(tokenAddress) !==
            getAddress(this.context.options.protocol.context.tokenAddress)
        )
            throw new Error("preparation token mismatch");
        return this.context;
    }
    private get scope() {
        return this.context.scope;
    }
    async prepareTransfer(options: TransferPreparation): Promise<Result> {
        const copied = structuredClone(options);
        const runtime = this.runtime(copied.tokenAddress);
        if (copied.commitments !== undefined && copied.commitments.length === 0)
            throw new Error("empty explicit input selection");
        const preparation = new Preparation({
            ...runtime,
            ...(copied.commitments !== undefined ? { inputSelection: copied.commitments } : {}),
        });
        const frame = await preparation.frame(copied.deadline);
        if (copied.outputs.length > 168) throw new Error("transfer supports at most 168 outputs");
        let withdrawalAddress: Hex = ZERO_ADDRESS;
        let withdrawalAmount = 0n;
        if (copied.withdrawal !== undefined) {
            withdrawalAddress = getAddress(copied.withdrawal.to) as Hex;
            positiveAmount(copied.withdrawal.amount);
            if (BigInt(withdrawalAddress) === 0n)
                throw new Error("withdrawal destination must be nonzero");
            withdrawalAmount = copied.withdrawal.amount;
        }
        if (copied.outputs.length === 0 && withdrawalAmount === 0n)
            throw new Error("transfer requires a private output or public withdrawal");
        const total = copied.outputs.reduce(
            (sum, output, index) => sum + positiveOutputAmount(output, index),
            withdrawalAmount
        );
        const funding = await preparation.funding(copied.funding, frame);
        return this.funds(
            copied.outputs,
            total,
            withdrawalAddress,
            withdrawalAmount,
            frame,
            funding,
            copied.target,
            preparation
        );
    }

    private async funds(
        payments: readonly PaymentOutput[],
        total: bigint,
        withdrawalAddress: `0x${string}`,
        withdrawalAmount: bigint,
        frame: PreparationFrame,
        funding: Pick<OperationPlan, "funding" | "fundingMode">,
        target: ProofTarget | undefined,
        preparation: Preparation<Result>
    ): Promise<Result> {
        if (total >= 1n << 135n) {
            throw new Error("transaction sum exceeds uint135");
        }
        const { context, block, deadline } = frame;
        const selection = await preparation.selectFunds(
            total - (funding.funding.amount ?? 0n),
            frame
        );
        const outputs = await Promise.all(
            payments.map((payment, index) => preparation.output(payment, context, false, index))
        );
        const change = selection.amount + (funding.funding.amount ?? 0n) - total;
        if (change > 0n) {
            outputs.push(
                await preparation.output(
                    {
                        to:
                            this.context.changeAddress ??
                            this.context.options.wallet.getReceivingAddress().toString(),
                        amount: change,
                    },
                    context,
                    true
                )
            );
        }
        const params = {
            token: context.tokenAddress,
            sources: selection.sources,
            nullifiers: selection.nullifiers,
            outputCommitments: outputs.map((output) => output.commitment),
            withdrawalAddress,
            withdrawalAmount,
            deadline,
        };
        const deliveries = outputs.map((output) => output.delivery);
        const normalized = normalizeTransactRequest(context, params, deliveries, funding.funding);
        const statement = WitnessBuilder.statement(
            `transact_user_slots${normalized.capacity}`,
            transactUserPublicInputs(context, params, deliveries, funding.funding),
            target ?? "evm"
        );
        await preparation.assertBlock(frame);
        return preparation.runtime.complete({
            version: 1,
            id: crypto.randomUUID(),
            kind: "transfer",
            context,
            scope: this.scope,
            preparedAt: block,
            deadline,
            outputs,
            inputs: selection.inputs,
            ...funding,
            params,
            capacity: normalized.capacity,
            statement,
        });
    }

    async prepareShield(options: ShieldPreparation): Promise<Result> {
        const copied = structuredClone(options);
        const preparation = new Preparation(this.runtime(copied.tokenAddress));
        const frame = await preparation.frame(copied.deadline);
        const funding = await preparation.funding(copied.funding, frame);
        if (copied.outputs.length < 1 || copied.outputs.length > 10) {
            throw new Error("shield requires 1..10 outputs");
        }
        const outputs = await Promise.all(
            copied.outputs.map((output, index) =>
                preparation.output(output, frame.context, false, index)
            )
        );
        if (
            outputs.reduce((sum, output) => sum + output.note.amount, 0n) !==
            (funding.funding.amount ?? 0n)
        ) {
            throw new Error("shield funding must equal output total");
        }
        await preparation.assertBlock(frame);
        return preparation.runtime.complete({
            version: 1,
            id: crypto.randomUUID(),
            kind: "shield",
            context: frame.context,
            scope: this.scope,
            preparedAt: frame.block,
            deadline: frame.deadline,
            outputs,
            inputs: [],
            ...funding,
            shieldParams: {
                token: frame.context.tokenAddress,
                outputCommitments: outputs.map((output) => output.commitment),
                deadline: frame.deadline,
            },
            shieldOutputs: outputs.map((output) => ({
                identity: output.identity,
                amount: output.note.amount,
            })),
        });
    }

    prepareCreateCredit(options: CreateCreditPreparation): Promise<Result> {
        return new CreditPreparation(this.runtime(options.tokenAddress)).create(
            structuredClone(options)
        );
    }

    prepareDrawCredit(options: DrawCreditPreparation): Promise<Result> {
        return new CreditPreparation(this.runtime(options.tokenAddress)).draw(
            structuredClone(options)
        );
    }

    prepareTopUpCredit(options: TopUpCreditPreparation): Promise<Result> {
        return new CreditPreparation(this.runtime(options.tokenAddress)).topUp(
            structuredClone(options)
        );
    }

    prepareCancelCredit(options: CancelCreditPreparation): Promise<Result> {
        return new CreditPreparation(this.runtime(options.tokenAddress)).cancel(
            structuredClone(options)
        );
    }
}
