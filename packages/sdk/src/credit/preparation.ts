import { mapPreparation } from "../transactions/preparation/parallel";
import { NoteOutput } from "../notes/NoteOutput";
import type {
    CreditCreationParams,
    Delivery,
    Hex,
    InputSource,
} from "@invisi-labs/protocol/contracts";
import { getAddress, toBeHex } from "ethers";
import { recipientLookup } from "../notes/recipient-infrastructure";
import { resolveRecipient } from "../notes/resolve-recipient";

import {
    FIELD_MODULUS,
    applyCreditDrawUsage,
    computeCreditNullifier,
    computeCreditRecoveryPad,
    deriveCreditStateNonce,
    generateCreditSharedKey,
    generateCreditGrantId,
    normalizeCreditGrantId,
    generateNonce,
    normalizeCreditDeliveryState,
    normalizeCreditPolicy,
    deriveCreditState,
    deriveCreditUpdate,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { WitnessBuilder } from "@invisi-labs/prover";
import {
    normalizeFee,
    encodeRevokeCreditTypedData,
    createCreditPublicInputs,
    creditDrawPublicInputs,
    selectCreditDrawCircuit,
    updateCreditPublicInputs,
    word,
} from "@invisi-labs/protocol";
import type { CircuitName } from "@invisi-labs/prover";
import { sealCreditOutput } from "./seal";
import { creditLeaf } from "./state";

import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    PreparationRuntime,
    PreparedCreditInput,
    PreparedCreditOutput,
    UpdateCreditPreparation,
} from "../transactions/operation-types";
import {
    Preparation,
    copyApplicationPayload,
    positiveAmount,
    type PreparationFrame,
} from "../transactions/preparation/prepare-common";

const EMPTY: Delivery = { ciphertext: "0x", clue: "0x" };

/** Credit roles, grant references and receiving snapshots are frozen before authorization. */
export class CreditPreparation<Result> {
    readonly #prepare: Preparation<Result>;

    constructor(readonly runtime: PreparationRuntime<Result>) {
        this.#prepare = new Preparation(runtime);
    }

    private fee(options: { fee?: { recipient: Hex; amount: bigint } }) {
        return normalizeFee(
            options.fee
                ? { feeRecipient: options.fee.recipient, feeAmount: options.fee.amount }
                : {}
        );
    }

    private expiry(value: bigint, frame: PreparationFrame): bigint {
        if (typeof value !== "bigint" || value <= frame.timestamp || value >= 1n << 64n) {
            throw new Error("Credit expiry must be a future uint64 timestamp");
        }
        return value;
    }

    private async input(
        commitment: Hex,
        role: "owner" | "spender",
        frame: PreparationFrame
    ): Promise<{ input: PreparedCreditInput; nullifier: Hex; source: InputSource }> {
        const stored = (await this.#prepare.inventory()).credits[commitment + ":" + role];
        if (!stored || stored.spent !== "unspent" || stored.role !== role) {
            throw new Error(`confirmed unspent ${role} Credit is unavailable`);
        }
        const state = normalizeCreditDeliveryState(stored.state);
        const n = state.note;
        if (
            (role === "owner" ? n.ownerWalletIdentity : n.spenderWalletIdentity) !==
                this.runtime.scope.ownerAddress ||
            n.chainId !== frame.context.chainId ||
            n.protocolAddress !== BigInt(frame.context.protocolAddress) ||
            n.tokenAddress !== BigInt(frame.context.tokenAddress) ||
            (await creditLeaf(state)) !== commitment
        ) {
            throw new Error("Credit role, commitment or deployment mismatch");
        }
        if (!this.runtime.reader.getCreditStatus) throw Error("Credit status reader required");
        const status = await this.runtime.reader.getCreditStatus(
            frame.context,
            n.ownerWalletIdentity,
            frame.context.tokenAddress,
            n.grantId,
            frame.block
        );
        if (status !== 1)
            throw Error(status === 2 ? "Credit grant is revoked" : "Credit grant is not active");
        const proof = await this.#prepare.membership(stored, frame);
        const path = [...proof.path];
        const nullifier = await computeCreditNullifier(n.chainId, n.creditSharedKey, commitment);
        await this.#prepare.assertUnspent([nullifier], frame);
        return {
            input: {
                state,
                commitment,
                role,
                treeId: stored.treeId,
                leafIndex: stored.leafIndex,
                path,
            },
            nullifier,
            source: {
                treeId: stored.treeId,
                merkleRoot: proof.root,
            },
        };
    }

    private base(frame: PreparationFrame, kind: OperationPlan["kind"]): OperationPlan {
        return {
            version: 1,
            id: crypto.randomUUID(),
            kind,
            context: frame.context,
            scope: this.runtime.scope,
            preparedAt: frame.block,
            deadline: frame.deadline,
            outputs: [],
            inputs: [],
            funding: {},
            fundingMode: "none",
        };
    }

    async create(options: CreateCreditPreparation): Promise<Result> {
        if (
            options.creditSharedKey !== undefined &&
            (typeof options.creditSharedKey !== "bigint" ||
                options.creditSharedKey <= 0n ||
                options.creditSharedKey >= FIELD_MODULUS)
        )
            throw Error("Credit shared key must be a canonical nonzero field");
        for (const key of Object.keys(options))
            if (
                ![
                    "payload",
                    "fee",
                    "singleLimit",
                    "dailyLimit",
                    "monthlyLimit",
                    "creditSharedKey",
                    "grantId",
                    "initialPayment",
                    "availableCredit",
                    "unlimited",
                    "tokenAddress",
                    "spender",
                    "expiry",
                    "deadline",
                ].includes(key)
            )
                throw Error("unsupported Credit creation option");
        const frame = await this.#prepare.frame(options.deadline),
            expiry = this.expiry(options.expiry, frame);
        if (expiry < frame.deadline) throw Error("expiry before request deadline");
        const grantId = normalizeCreditGrantId(options.grantId ?? generateCreditGrantId());
        if (!this.runtime.reader.getCreditStatus) throw Error("Credit status reader required");
        const status = await this.runtime.reader.getCreditStatus(
            frame.context,
            this.runtime.scope.ownerAddress,
            frame.context.tokenAddress,
            grantId,
            frame.block
        );
        if (status !== 0)
            throw Error("Credit grant ID is already active, revoked or has invalid status");
        const [spender, owner] = await Promise.all([
            resolveRecipient(options.spender, recipientLookup(this.runtime.options), {
                field: "spender",
            }),
            resolveRecipient(
                this.runtime.options.wallet.getReceivingAddress().toString(),
                recipientLookup(this.runtime.options),
                { field: "wallet" }
            ),
        ]);
        const fee = this.fee(options);
        const initialAvailableCredit = options.availableCredit ?? 0n;
        const initial: CreditDeliveryState["note"] = {
            chainId: frame.context.chainId,
            protocolAddress: BigInt(frame.context.protocolAddress),
            tokenAddress: BigInt(frame.context.tokenAddress),
            ownerWalletIdentity: this.runtime.scope.ownerAddress,
            spenderWalletIdentity: spender.ownerAddress,
            grantId,
            ...normalizeCreditPolicy(options),
            availableCredit: options.availableCredit === undefined ? 0n : options.availableCredit,
            unlimited: options.unlimited === undefined ? false : options.unlimited,
            payload: copyApplicationPayload(options.payload),
            expiry,
            nonce: generateNonce(),
            creditSharedKey: options.creditSharedKey ?? generateCreditSharedKey(),
        };
        const initialPayment = options.initialPayment;
        if (
            initialPayment &&
            Object.keys(initialPayment).some(
                (key) => !["amount", "netAmount", "payload"].includes(key)
            )
        )
            throw Error("unsupported initial payment option");
        const totalAmount = initialPayment ? positiveAmount(initialPayment.amount, 126) : 0n;
        if (
            initialPayment?.netAmount !== undefined &&
            totalAmount !== positiveAmount(initialPayment.netAmount, 126) + fee.feeAmount
        )
            throw Error("initial payment gross amount must equal netAmount plus fee");
        if (initialPayment && totalAmount <= fee.feeAmount)
            throw Error("initial payment must leave a positive Note");
        const ordinary = initialPayment
            ? await this.#prepare.output(
                  await NoteOutput.create({
                      chainId: frame.context.chainId,
                      protocolAddress: frame.context.protocolAddress,
                      tokenAddress: frame.context.tokenAddress,
                      amount: totalAmount - fee.feeAmount,
                      recipient: { type: "invisi", address: options.spender },
                      payload: copyApplicationPayload(initialPayment.payload),
                  }),
                  frame.context,
                  false
              )
            : undefined;
        if (ordinary && !ordinary.note)
            throw Error("initial payment requires an encrypted Note recipient");
        const output = await sealCreditOutput(
            {
                note: ordinary
                    ? { ...initial, ...applyCreditDrawUsage(initial, totalAmount, frame.timestamp) }
                    : initial,
                ownerReceivingKeys: owner.getReceivingKeys(),
                spenderReceivingKeys: spender.getReceivingKeys(),
            },
            frame.context
        );
        const plan = this.base(frame, "create-credit"),
            params: CreditCreationParams = {
                token: frame.context.tokenAddress,
                owner: this.runtime.scope.ownerAddress,
                grantId,
                creditCommitment: output.commitment,
                deadline: frame.deadline,
                ...fee,
                ...(ordinary
                    ? {
                          hasInitialPayment: true as const,
                          totalAmount,
                          noteCommitment: ordinary.commitment,
                      }
                    : { hasInitialPayment: false as const }),
            };
        const deliveries = ordinary ? [...output.deliveries, ordinary.delivery] : output.deliveries;
        plan.capacity = 1;
        if (ordinary) plan.outputs = [ordinary];
        plan.credit = {
            inputs: [],
            outputs: [output],
            deliveries,
            creation: params,
            ...(ordinary ? { initialPaymentInitialAvailableCredit: initialAvailableCredit } : {}),
        };
        plan.statement = WitnessBuilder.statement(
            ordinary ? "create_credit_initial_payment" : "create_credit",
            createCreditPublicInputs(frame.context, params, deliveries)
        );
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }
    async update(options: UpdateCreditPreparation): Promise<Result> {
        for (const key of Object.keys(options))
            if (
                ![
                    "payload",
                    "fee",
                    "singleLimit",
                    "dailyLimit",
                    "monthlyLimit",
                    "increaseAvailableCredit",
                    "decreaseAvailableCredit",
                    "unlimited",
                    "tokenAddress",
                    "credit",
                    "expiry",
                    "deadline",
                    "creditInputs",
                ].includes(key)
            )
                throw Error("unsupported Credit update option");
        const frame = await this.#prepare.frame(options.deadline),
            previous = await this.input(options.credit, "owner", frame),
            n = previous.input.state.note;
        const changes = {
            ...Object.fromEntries(
                (
                    [
                        "singleLimit",
                        "dailyLimit",
                        "monthlyLimit",
                        "unlimited",
                        "increaseAvailableCredit",
                        "decreaseAvailableCredit",
                        "expiry",
                    ] as const
                )
                    .filter((k) => options[k] !== undefined)
                    .map((k) => [k, options[k]])
            ),
        };
        const next = await deriveCreditUpdate(n, changes, frame.deadline),
            output = await sealCreditOutput(
                {
                    ...previous.input.state,
                    note: {
                        ...next.state,
                        payload: copyApplicationPayload(
                            options.payload === undefined ? n.payload : options.payload
                        ),
                    },
                },
                frame.context
            );
        const params = {
                token: frame.context.tokenAddress,
                owner: n.ownerWalletIdentity,
                source: previous.source,
                nullifier: next.nullifier,
                creditCommitment: output.commitment,
                grantId: n.grantId,
                deadline: frame.deadline,
                ...this.fee(options),
            },
            plan = this.base(frame, "update-credit");
        plan.capacity = 1;
        plan.credit = {
            inputs: [previous.input],
            outputs: [output],
            deliveries: output.deliveries,
            update: params,
            updateChanges: structuredClone(changes),
        };
        plan.statement = WitnessBuilder.statement(
            "credit_update",
            updateCreditPublicInputs(frame.context, params, output.deliveries)
        );
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }
    async draw(options: DrawCreditPreparation): Promise<Result> {
        const frame = await this.#prepare.frame(options.deadline),
            profile = selectCreditDrawCircuit(options.credits.length);
        if (new Set(options.credits.map((c) => c.credit)).size !== options.credits.length)
            throw Error("duplicate Credit input");
        const members = await mapPreparation(options.credits, async (value) => ({
            ...(await this.input(value.credit, "spender", frame)),
            value,
        }));
        members.sort((a, b) => {
            const x = a.input.state.note,
                y = b.input.state.note;
            for (const [u, v] of [
                [BigInt(x.ownerWalletIdentity), BigInt(y.ownerWalletIdentity)],
                [x.grantId, y.grantId],
            ]) {
                if (u! < v!) return -1;
                if (u! > v!) return 1;
            }
            return 0;
        });
        const payers: { payer: Hex; amount: bigint }[] = [],
            sources = new Map<bigint, Hex>(),
            outputs: PreparedCreditOutput[] = [],
            recoveryAmounts: Hex[] = [],
            grantRefs: { payerIndex: bigint; grantId: bigint }[] = [],
            amounts: bigint[] = [];
        for (const member of members) {
            const n = member.input.state.note,
                amount = positiveAmount(member.value.amount, 126);
            if (n.expiry < frame.deadline) throw Error("expiry before request deadline");
            let pi = payers.findIndex((p) => p.payer === n.ownerWalletIdentity);
            if (pi < 0) {
                pi = payers.length;
                payers.push({ payer: n.ownerWalletIdentity, amount: 0n });
            }
            payers[pi]!.amount += amount;
            grantRefs.push({
                payerIndex: BigInt(pi),
                grantId: n.grantId,
            });
            if (
                sources.has(member.source.treeId) &&
                sources.get(member.source.treeId) !== member.source.merkleRoot
            )
                throw Error("Credit source root mismatch");
            sources.set(member.source.treeId, member.source.merkleRoot);
            const next = await deriveCreditState(n, amount, frame.timestamp);
            outputs.push(
                await sealCreditOutput(
                    {
                        ...member.input.state,
                        note: {
                            ...next.state,
                            payload: copyApplicationPayload(
                                member.value.payload === undefined
                                    ? n.payload
                                    : member.value.payload
                            ),
                        },
                    },
                    frame.context
                )
            );
            recoveryAmounts.push(word(next.recoveryAmount));
            amounts.push(amount);
        }
        const totalAmount = amounts.reduce((sum, n) => sum + n, 0n),
            fee = this.fee(options),
            payment = await NoteOutput.create({
                chainId: frame.context.chainId,
                protocolAddress: frame.context.protocolAddress,
                tokenAddress: frame.context.tokenAddress,
                amount: totalAmount - fee.feeAmount,
                recipient: options.recipient.startsWith("0i")
                    ? { type: "invisi", address: options.recipient }
                    : { type: "evm", address: options.recipient },
                payload: copyApplicationPayload(options.payload),
            }),
            ordinary = await this.#prepare.output(payment, frame.context, false);
        if (!ordinary.note)
            throw Error("Credit draw requires an encrypted ordinary Note recipient");
        const deliveries = [...outputs.flatMap((o) => o.deliveries), ordinary.delivery],
            params = {
                token: frame.context.tokenAddress,
                sources: [...sources]
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([treeId, merkleRoot]) => ({ treeId, merkleRoot })),
                payers,
                grantRefs,
                nullifiers: members.map((m) => m.nullifier),
                creditCommitments: outputs.map((o) => o.commitment),
                recoveryAmounts,
                noteCommitment: ordinary.commitment,
                totalAmount,
                deadline: frame.deadline,
                ...fee,
            },
            plan = this.base(frame, "draw-credit");
        plan.capacity = profile.capacity;
        plan.outputs = [ordinary];
        plan.credit = {
            inputs: members.map((m) => m.input),
            outputs,
            deliveries,
            draw: params,
            amounts,
        };
        plan.statement = WitnessBuilder.statement(
            profile.name as CircuitName,
            creditDrawPublicInputs(frame.context, params, deliveries)
        );
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }
    async revoke(options: RevokeCreditPreparation): Promise<Result> {
        const frame = await this.#prepare.frame(options.deadline, options.fee?.amount ?? 0n),
            params = {
                token: frame.context.tokenAddress,
                owner: options.owner ?? this.runtime.scope.ownerAddress,
                grantId: normalizeCreditGrantId(options.grantId),
                deadline: frame.deadline,
                ...this.fee(options),
            };
        if (!this.runtime.reader.getCreditStatus) throw Error("Credit status reader required");
        const status = await this.runtime.reader.getCreditStatus(
            frame.context,
            params.owner,
            params.token,
            params.grantId,
            frame.block
        );
        if (status !== 0 && status !== 1)
            throw Error("Credit grant is revoked or has invalid status");
        encodeRevokeCreditTypedData(frame.context, params);
        const plan = this.base(frame, "revoke-credit");
        plan.credit = {
            inputs: [],
            outputs: [],
            deliveries: [],
            revocation: params,
            ...(options.caller ? { revocationCaller: options.caller } : {}),
        };
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }
}
