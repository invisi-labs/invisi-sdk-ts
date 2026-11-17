import { mapPreparation } from "../transactions/preparation/parallel";
import { NoteOutput } from "../notes/NoteOutput";
import type {
    CreateCreditParams,
    Delivery,
    Hex,
    InputSource,
} from "@invisi-labs/protocol/contracts";
import { getAddress, hexlify, toBeHex } from "ethers";
import { recipientLookup } from "../notes/recipient-infrastructure";
import { resolveRecipient } from "../notes/resolve-recipient";

import {
    FIELD_MODULUS,
    applyCreditDrawUsage,
    computeCreditNullifier,
    computeCreditRecoveryPad,
    createClue,
    deriveCreditStateNonce,
    encryptCreditState,
    generateCreditSharedKey,
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

    private async seal(
        input: CreditDeliveryState,
        frame: PreparationFrame
    ): Promise<PreparedCreditOutput> {
        const state = normalizeCreditDeliveryState(input);
        const commitment = await creditLeaf(state);
        const context = {
            chainId: frame.context.chainId,
            protocolAddress: BigInt(frame.context.protocolAddress),
            outputCommitment: commitment,
        };
        const deliveries = (await Promise.all(
            (["owner", "spender"] as const).map(async (role) => {
                const keys =
                    role === "owner" ? state.ownerReceivingKeys : state.spenderReceivingKeys;
                return {
                    ciphertext: hexlify(
                        await encryptCreditState(keys.viewingPublicKey, state, { ...context, role })
                    ) as Hex,
                    clue: hexlify(createClue(keys.clueKey)) as Hex,
                };
            })
        )) as [Delivery, Delivery];
        return { state, commitment, deliveries };
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
        if (!this.runtime.reader.getCreditRevocationBitmap)
            throw Error("Credit revocation reader required");
        const bitmap = await this.runtime.reader.getCreditRevocationBitmap(
            frame.context,
            n.ownerWalletIdentity,
            frame.context.tokenAddress,
            n.revocationShard,
            Number(n.revocationSlot >> 8n),
            frame.block
        );
        if (bitmap & (1n << (n.revocationSlot & 255n))) throw Error("Credit grant is revoked");
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
        if (!this.runtime.reader.getCreditAllocation)
            throw Error("Credit allocation reader required");
        const [allocation, spender, owner] = await Promise.all([
            this.runtime.reader.getCreditAllocation(
                frame.context,
                this.runtime.scope.ownerAddress,
                frame.context.tokenAddress,
                frame.block
            ),
            resolveRecipient(options.spender, recipientLookup(this.runtime.options), {
                field: "spender",
            }),
            resolveRecipient(
                this.runtime.options.wallet.getReceivingAddress().toString(),
                recipientLookup(this.runtime.options),
                { field: "wallet" }
            ),
        ]);
        const output = await this.seal(
            {
                note: {
                    chainId: frame.context.chainId,
                    protocolAddress: BigInt(frame.context.protocolAddress),
                    tokenAddress: BigInt(frame.context.tokenAddress),
                    ownerWalletIdentity: this.runtime.scope.ownerAddress,
                    spenderWalletIdentity: spender.ownerAddress,
                    revocationShard: allocation.shard,
                    revocationSlot: BigInt(allocation.slot),
                    ...normalizeCreditPolicy(options),
                    availableCredit:
                        options.availableCredit === undefined ? 0n : options.availableCredit,
                    unlimited: options.unlimited === undefined ? false : options.unlimited,
                    payload: copyApplicationPayload(options.payload),
                    expiry,
                    nonce: generateNonce(),
                    creditSharedKey: options.creditSharedKey ?? generateCreditSharedKey(),
                },
                ownerReceivingKeys: owner.getReceivingKeys(),
                spenderReceivingKeys: spender.getReceivingKeys(),
            },
            frame
        );
        const plan = this.base(frame, "create-credit"),
            params = {
                token: frame.context.tokenAddress,
                owner: this.runtime.scope.ownerAddress,
                revocationShard: allocation.shard,
                revocationSlot: BigInt(allocation.slot),
                creditCommitment: output.commitment,
                deadline: frame.deadline,
                ...this.fee(options),
            };
        plan.capacity = 1;
        plan.credit = {
            inputs: [],
            outputs: [output],
            deliveries: output.deliveries,
            creation: params,
        };
        plan.statement = WitnessBuilder.statement(
            "create_credit",
            createCreditPublicInputs(frame.context, params, output.deliveries)
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
            output = await this.seal(
                {
                    ...previous.input.state,
                    note: {
                        ...next.state,
                        payload: copyApplicationPayload(
                            options.payload === undefined ? n.payload : options.payload
                        ),
                    },
                },
                frame
            );
        const params = {
                token: frame.context.tokenAddress,
                owner: n.ownerWalletIdentity,
                source: previous.source,
                nullifier: next.nullifier,
                creditCommitment: output.commitment,
                revocationShard: n.revocationShard,
                revocationSlot: n.revocationSlot,
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
                [x.revocationShard, y.revocationShard],
                [x.revocationSlot, y.revocationSlot],
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
            grantRefs: { payerIndex: bigint; shard: bigint; slot: bigint }[] = [],
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
                shard: n.revocationShard,
                slot: n.revocationSlot,
            });
            if (
                sources.has(member.source.treeId) &&
                sources.get(member.source.treeId) !== member.source.merkleRoot
            )
                throw Error("Credit source root mismatch");
            sources.set(member.source.treeId, member.source.merkleRoot);
            const next = await deriveCreditState(n, amount, frame.timestamp);
            outputs.push(
                await this.seal(
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
                    frame
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
        const frame = await this.#prepare.frame(options.deadline),
            params = {
                token: frame.context.tokenAddress,
                owner: options.owner ?? this.runtime.scope.ownerAddress,
                shard: options.shard,
                slot: options.slot,
                deadline: frame.deadline,
                ...this.fee(options),
            };
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
