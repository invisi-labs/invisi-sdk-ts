import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress } from "ethers";
import {
    normalizeTransactRequest,
    transactUserPublicInputs,
    WitnessBuilder,
    ZERO_ADDRESS,
} from "@invisi-labs/protocol";
import type { ProofTarget } from "@invisi-labs/prover";
import { positiveAmount, Preparation, type PreparationFrame } from "./prepare-common";
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
    WithdrawalPreparation,
    SweepPreparation,
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
        const preparation = new Preparation(this.runtime(copied.tokenAddress));
        const frame = await preparation.frame(copied.deadline);
        if (copied.outputs.length < 1 || copied.outputs.length > 168) {
            throw new Error("transfer requires 1..168 outputs");
        }
        const total = copied.outputs.reduce(
            (sum, output) => sum + positiveAmount(output.amount),
            0n
        );
        const funding = await preparation.funding(copied.funding, frame);
        return this.funds(
            "transfer",
            copied.outputs,
            total,
            ZERO_ADDRESS,
            0n,
            frame,
            funding,
            copied.target,
            preparation
        );
    }

    async prepareWithdraw(options: WithdrawalPreparation): Promise<Result> {
        const copied = structuredClone(options);
        const preparation = new Preparation(this.runtime(copied.tokenAddress));
        const frame = await preparation.frame(copied.deadline);
        const to = getAddress(copied.to) as Hex;
        positiveAmount(copied.amount);
        if (BigInt(to) === 0n) {
            throw new Error("withdrawal destination must be nonzero");
        }
        return this.funds(
            "withdraw",
            [],
            copied.amount,
            to,
            copied.amount,
            frame,
            { funding: {}, fundingMode: "none" },
            copied.target,
            preparation
        );
    }

    /** Full payout to the note owner; no arbitrary destination, change or spending signature. */
    async prepareSweep(options: SweepPreparation): Promise<Result> {
        const copied = structuredClone(options);
        const runtime = this.runtime(copied.tokenAddress);
        const state = await runtime.readInventory();
        const available = Object.values(state.notes).filter(
            (record) =>
                record.note.tokenAddress === BigInt(copied.tokenAddress) &&
                record.spent === "unspent" &&
                !state.reservations[record.commitment]
        );
        const selected = copied.commitments ?? available.map((record) => record.commitment);
        if (selected.length === 0) throw new Error("empty sweep input selection");
        if (new Set(selected).size !== selected.length) throw new Error("duplicate sweep inputs");
        const byId = new Map(available.map((record) => [record.commitment, record]));
        let amount = 0n;
        for (const id of selected) {
            const record = byId.get(id);
            if (!record) throw new Error("sweep input unavailable");
            amount += record.note.amount;
        }
        positiveAmount(amount);
        const preparation = new Preparation({
            ...runtime,
            inputSelection: selected,
        });
        const frame = await preparation.frame(copied.deadline);
        return this.funds(
            "sweep",
            [],
            amount,
            this.scope.walletIdentity,
            amount,
            frame,
            { funding: {}, fundingMode: "none" },
            copied.target,
            preparation
        );
    }

    private async funds(
        kind: "transfer" | "withdraw" | "sweep",
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
            payments.map((payment) => preparation.output(payment, context))
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
            kind,
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
            copied.outputs.map((output) => preparation.output(output, frame.context))
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
