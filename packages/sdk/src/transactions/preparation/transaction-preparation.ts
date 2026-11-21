import { mapPreparation } from "./parallel";
import { PreparationReads } from "./preparation-reads";
import {
    normalizeTransactRequest,
    transactUserPublicInputs,
    ZERO_ADDRESS,
} from "@invisi-labs/protocol";
import { WitnessBuilder } from "@invisi-labs/prover";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress } from "ethers";
import { NoteOutput, resolvedOutputSnapshot } from "../../notes/NoteOutput";
import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    PreparationRuntime,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransferPreparation,
} from "../operation-types";
import {
    positiveAmount,
    positiveOutputAmount,
    Preparation,
    type PreparationFrame,
} from "./prepare-common";

/** Shared preparation engine for managed sessions and explicitly supplied inputs. */
export class TransactionPreparation<Result> {
    #intent: import("../../broadcaster/broadcaster-preparation").PreparationIntent | undefined;
    constructor(readonly context: PreparationRuntime<Result>) {
        const complete = context.complete;
        const reads =
            context.preparationReads ??
            new PreparationReads(context.reader, context.options.protocolRpc);
        const protocolRpc = reads.provider(context.repricing);
        this.context = {
            ...context,
            reader: reads.reader(context.repricing),
            options: { ...context.options, ...(protocolRpc ? { protocolRpc } : {}) },
            complete: (plan) => {
                const intent = this.#intent ? structuredClone(this.#intent) : undefined;
                if (intent && (intent.kind === "transfer" || intent.kind === "shield")) {
                    const businessOutputs = plan.outputs.filter((output) => !output.change);
                    intent.options.outputs = intent.options.outputs.map((payment, index) =>
                        resolvedOutputSnapshot(payment, businessOutputs[index]!)
                    );
                }
                if (intent?.kind === "create-credit") {
                    const note = plan.credit!.outputs[0]!.state.note;
                    intent.options.grantId = note.grantId;
                    intent.options.creditSharedKey = note.creditSharedKey;
                }
                return complete({ ...plan, ...(intent ? { intent } : {}) });
            },
        };
    }
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
        this.#intent = { kind: "transfer", options: structuredClone(options) };
        if (Object.hasOwn(options, "target") || Object.hasOwn(options, "execution")) {
            throw new Error(
                "prepareTransfer accepts no target or execution; choose execution in prove()"
            );
        }
        const copied = structuredClone(options);
        const runtime = this.runtime(copied.tokenAddress);
        if (copied.commitments !== undefined && copied.commitments.length === 0)
            throw new Error("empty explicit input selection");
        const preparation = new Preparation({
            ...runtime,
            ...(copied.commitments !== undefined ? { inputSelection: copied.commitments } : {}),
        });
        const frame = await preparation.frame(copied.deadline);
        if (copied.outputs.length > 190) throw new Error("transfer supports at most 190 outputs");
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
        const feeRecipient = copied.fee ? (getAddress(copied.fee.recipient) as Hex) : ZERO_ADDRESS;
        const feeAmount = copied.fee?.amount ?? 0n;
        if (copied.fee) {
            positiveAmount(feeAmount);
            if (BigInt(feeRecipient) === 0n) throw new Error("fee recipient must be nonzero");
        }
        const total = copied.outputs.reduce(
            (sum, output, index) => sum + positiveOutputAmount(output, index),
            withdrawalAmount + feeAmount
        );
        const funding = await preparation.funding(copied.funding, frame);
        return this.funds(
            copied.outputs,
            total,
            withdrawalAddress,
            withdrawalAmount,
            { recipient: feeRecipient, amount: feeAmount },
            frame,
            funding,
            preparation
        );
    }

    private async funds(
        payments: readonly NoteOutput[],
        total: bigint,
        withdrawalAddress: `0x${string}`,
        withdrawalAmount: bigint,
        fee: { recipient: Hex; amount: bigint },
        frame: PreparationFrame,
        funding: Pick<OperationPlan, "funding" | "fundingMode">,
        preparation: Preparation<Result>
    ): Promise<Result> {
        if (total >= 1n << 135n) {
            throw new Error("transaction sum exceeds uint135");
        }
        const { context, block, deadline } = frame;
        const [selection, outputs] = await Promise.all([
            preparation.selectFunds(total - (funding.funding.amount ?? 0n), frame),
            mapPreparation(payments, (payment, index) =>
                preparation.output(payment, context, false, index)
            ),
        ]);
        const change = selection.amount + (funding.funding.amount ?? 0n) - total;
        if (change > 0n) {
            outputs.push(await preparation.change(change, context));
        }
        const params = {
            token: context.tokenAddress,
            sources: selection.sources,
            nullifiers: selection.nullifiers,
            noteCommitments: outputs.map((output) => output.commitment),
            withdrawalAddress,
            withdrawalAmount,
            deadline,
            feeRecipient: fee.recipient,
            feeAmount: fee.amount,
        };
        const deliveries = outputs.map((output) => output.delivery);
        const normalized = normalizeTransactRequest(context, params, deliveries, funding.funding);
        const statement = WitnessBuilder.statement(
            `transact_user_slots${normalized.capacity}`,
            transactUserPublicInputs(context, params, deliveries, funding.funding),
            "evm"
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
        this.#intent = { kind: "shield", options: structuredClone(options) };
        const copied = structuredClone(options);
        const preparation = new Preparation(this.runtime(copied.tokenAddress));
        const frame = await preparation.frame(copied.deadline);
        if (copied.outputs.length < 1 || copied.outputs.length > 10) {
            throw new Error("shield requires 1..10 outputs");
        }
        const [funding, outputs] = await Promise.all([
            preparation.funding(copied.funding, frame),
            mapPreparation(copied.outputs, (output, index) =>
                preparation.output(output, frame.context, false, index)
            ),
        ]);
        if (
            outputs.reduce((sum, output) => sum + output.amount, 0n) !==
            (funding.funding.amount ?? 0n) - (copied.fee?.amount ?? 0n)
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
                feeRecipient: copied.fee?.recipient ?? ZERO_ADDRESS,
                feeAmount: copied.fee?.amount ?? 0n,
                noteCommitments: outputs.map((output) => output.commitment),
                deadline: frame.deadline,
            },
            shieldOutputs: outputs.map((output) => ({
                identity: output.identity,
                amount: output.amount,
            })),
        });
    }

    async prepareCreateCredit(options: CreateCreditPreparation): Promise<Result> {
        const copied = structuredClone(options);
        this.#intent = { kind: "create-credit", options: structuredClone(copied) };
        const { CreditPreparation } = await import("../../credit/preparation");
        return new CreditPreparation(this.runtime(copied.tokenAddress)).create(copied);
    }

    async prepareDrawCredit(options: DrawCreditPreparation): Promise<Result> {
        const copied = structuredClone(options);
        this.#intent = { kind: "draw-credit", options: structuredClone(copied) };
        const { CreditPreparation } = await import("../../credit/preparation");
        return new CreditPreparation(this.runtime(copied.tokenAddress)).draw(copied);
    }

    async prepareUpdateCredit(options: UpdateCreditPreparation): Promise<Result> {
        const copied = structuredClone(options);
        this.#intent = { kind: "update-credit", options: structuredClone(copied) };
        const { CreditPreparation } = await import("../../credit/preparation");
        return new CreditPreparation(this.runtime(copied.tokenAddress)).update(copied);
    }

    async prepareRevokeCredit(options: RevokeCreditPreparation): Promise<Result> {
        const copied = structuredClone(options);
        this.#intent = { kind: "revoke-credit", options: structuredClone(copied) };
        const { CreditPreparation } = await import("../../credit/preparation");
        return new CreditPreparation(this.runtime(copied.tokenAddress)).revoke(copied);
    }
}
