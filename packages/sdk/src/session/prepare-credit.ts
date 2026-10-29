import type {
    CreateCreditParams,
    Delivery,
    Hex,
    InputSource,
} from "@invisi-labs/protocol/contracts";
import { getAddress, hexlify, toBeHex } from "ethers";

import {
    FIELD_MODULUS,
    ReceivingAddress,
    computeCreditNullifier,
    computeCreditRecoveryPad,
    createClue,
    deriveRemainderNonce,
    encryptCreditNote,
    generateCreditSharedKey,
    generateNonce,
    normalizeCreditDeliveryState,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import {
    WitnessBuilder,
    cancelCreditPublicInputs,
    createCreditPublicInputs,
    creditDrawPublicInputs,
    selectCreditDrawCircuit,
    topUpCreditPublicInputs,
    word,
} from "@invisi-labs/protocol";
import type { CircuitName } from "@invisi-labs/prover";
import { creditLeaf } from "./credit-values";

import type {
    CancelCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    PreparationRuntime,
    PreparedCreditInput,
    PreparedCreditOutput,
    TopUpCreditPreparation,
} from "./operation-types";
import { Preparation, positiveAmount, type PreparationFrame } from "./prepare-common";

const EMPTY: Delivery = { ciphertext: "0x", clue: "0x" };

/** Current Credit roles, payout addresses and receiving snapshots are frozen before authorization. */
export class CreditPreparation<Result> {
    readonly #prepare: Preparation<Result>;

    constructor(readonly runtime: PreparationRuntime<Result>) {
        this.#prepare = new Preparation(runtime);
    }

    private expiry(value: bigint, frame: PreparationFrame): bigint {
        if (typeof value !== "bigint" || value <= frame.block.timestamp || value >= 1n << 64n) {
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
                        await encryptCreditNote(keys.viewingPublicKey, state, { ...context, role })
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
        const stored = (await this.runtime.readInventory()).credits[commitment + ":" + role];
        if (!stored || stored.spent !== "unspent" || stored.role !== role) {
            throw new Error(`confirmed unspent ${role} Credit is unavailable`);
        }
        const state = normalizeCreditDeliveryState(stored.state);
        const n = state.note;
        if (
            (role === "owner" ? n.ownerWalletIdentity : n.spenderWalletIdentity) !==
                this.runtime.scope.walletIdentity ||
            n.chainId !== frame.context.chainId ||
            n.protocolAddress !== BigInt(frame.context.protocolAddress) ||
            n.tokenAddress !== BigInt(frame.context.tokenAddress) ||
            (await creditLeaf(state)) !== commitment
        ) {
            throw new Error("Credit role, commitment or deployment mismatch");
        }
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
        positiveAmount(options.amount, 126);
        const frame = await this.#prepare.frame(options.deadline);
        const expiry = this.expiry(options.expiry, frame);
        const spender = await ReceivingAddress.parse(options.spender).resolve(
            this.runtime.options.addressResolver
        );
        const owner = await this.runtime.options.wallet
            .getReceivingAddress()
            .resolve(this.runtime.options.addressResolver);
        const ownerPayout = getAddress(owner.walletIdentity) as Hex;
        const spenderPayout = getAddress(spender.walletIdentity) as Hex;
        if (BigInt(ownerPayout) === 0n || BigInt(spenderPayout) === 0n) {
            throw new Error("Credit payouts must be nonzero");
        }
        const output = await this.seal(
            {
                note: {
                    chainId: frame.context.chainId,
                    protocolAddress: BigInt(frame.context.protocolAddress),
                    tokenAddress: BigInt(frame.context.tokenAddress),
                    ownerWalletIdentity: this.runtime.scope.walletIdentity,
                    spenderWalletIdentity: spender.walletIdentity,
                    ownerPayout: BigInt(ownerPayout),
                    spenderPayout: BigInt(spenderPayout),
                    amount: options.amount,
                    ...(options.memo === undefined ? {} : { memo: options.memo }),
                    expiry,
                    nonce: generateNonce(),
                    creditSharedKey: generateCreditSharedKey(),
                },
                ownerReceivingKeys: owner.getReceivingKeys(),
                spenderReceivingKeys: spender.getReceivingKeys(),
            },
            frame
        );
        return this.creation(
            this.base(frame, "create-credit"),
            output,
            options.amount,
            options.funding,
            frame
        );
    }

    private async creation(
        plan: OperationPlan,
        output: PreparedCreditOutput,
        delta: bigint,
        fundingSource: CreateCreditPreparation["funding"],
        frame: PreparationFrame,
        previous?: Awaited<ReturnType<CreditPreparation<Result>["input"]>>
    ): Promise<Result> {
        const funding = await this.#prepare.funding(fundingSource, frame);
        const selected = await this.#prepare.selectFunds(
            delta - (funding.funding.amount ?? 0n),
            frame,
            10
        );
        const change = selected.amount + (funding.funding.amount ?? 0n) - delta;
        plan.inputs = selected.inputs;
        Object.assign(plan, funding);
        if (change > 0n) {
            plan.outputs.push(
                await this.#prepare.output(
                    {
                        to:
                            this.runtime.changeAddress ??
                            this.runtime.options.wallet.getReceivingAddress().toString(),
                        amount: change,
                    },
                    frame.context,
                    true
                )
            );
        }
        const creation: CreateCreditParams = {
            token: frame.context.tokenAddress,
            sources: selected.sources,
            nullifiers: selected.nullifiers,
            creditCommitment: output.commitment,
            changeCommitment: plan.outputs[0]?.commitment ?? word(0n),
            owner: getAddress(toBeHex(output.state.note.ownerPayout, 20) as Hex) as Hex,
            expiry: output.state.note.expiry,
            deadline: frame.deadline,
        };
        const deliveries = [...output.deliveries, plan.outputs[0]?.delivery ?? { ...EMPTY }];
        plan.capacity = 10;
        plan.credit = {
            inputs: previous ? [previous.input] : [],
            outputs: [output],
            deliveries,
            creation,
        };
        if (previous) {
            plan.credit.topUp = {
                creation,
                creditSource: previous.source,
                creditNullifier: previous.nullifier,
                previousExpiry: previous.input.state.note.expiry,
            };
            plan.statement = WitnessBuilder.statement(
                "credit_top_up",
                topUpCreditPublicInputs(frame.context, plan.credit.topUp, deliveries, plan.funding)
            );
        } else {
            plan.statement = WitnessBuilder.statement(
                "create_credit",
                createCreditPublicInputs(frame.context, creation, deliveries, plan.funding)
            );
        }
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }

    async topUp(options: TopUpCreditPreparation): Promise<Result> {
        positiveAmount(options.additionalAmount, 126);
        const frame = await this.#prepare.frame(options.deadline);
        const previous = await this.input(options.credit, "owner", frame);
        const old = previous.input.state;
        if (old.note.expiry <= frame.block.timestamp) {
            throw new Error("previous Credit has expired");
        }
        const expiry = this.expiry(options.expiry ?? old.note.expiry, frame);
        if (expiry < old.note.expiry) {
            throw new Error("Credit expiry must not decrease");
        }
        const amount = positiveAmount(old.note.amount + options.additionalAmount, 126);
        const output = await this.seal(
            {
                ...old,
                note: {
                    ...old.note,
                    amount,
                    expiry,
                    nonce: generateNonce(),
                    ...(options.memo === undefined ? {} : { memo: options.memo }),
                },
            },
            frame
        );
        return this.creation(
            this.base(frame, "top-up-credit"),
            output,
            options.additionalAmount,
            options.funding,
            frame,
            previous
        );
    }

    async draw(options: DrawCreditPreparation): Promise<Result> {
        const frame = await this.#prepare.frame(options.deadline);
        const profile = selectCreditDrawCircuit(options.credits.length);
        if (new Set(options.credits.map((value) => value.credit)).size !== options.credits.length) {
            throw new Error("duplicate Credit input");
        }
        const members = await Promise.all(
            options.credits.map((value) => this.input(value.credit, "spender", frame))
        );
        const payout = members[0]!.input.state.note.spenderPayout;
        const sources = new Map<bigint, Hex>();
        const outputs: PreparedCreditOutput[] = [];
        const deliveries: Delivery[] = [];
        const recoveryAmounts: Hex[] = [];
        const remainders: Hex[] = [];
        const amounts: bigint[] = [];
        for (const [i, member] of members.entries()) {
            const state = member.input.state;
            const n = state.note;
            const amount = positiveAmount(options.credits[i]!.amount, 126);
            if (n.spenderPayout !== payout) {
                throw new Error(
                    "Credit draw requires separate groups for different public payouts; one call must be atomic"
                );
            }
            this.expiry(n.expiry, frame);
            if (amount > n.amount) {
                throw new Error("Credit draw exceeds remaining amount");
            }
            if (
                sources.has(member.source.treeId) &&
                sources.get(member.source.treeId) !== member.source.merkleRoot
            ) {
                throw new Error("Credit source root mismatch");
            }
            sources.set(member.source.treeId, member.source.merkleRoot);
            amounts.push(amount);
            const remaining = n.amount - amount;
            if (remaining === 0n) {
                remainders.push(word(0n));
                recoveryAmounts.push(word(0n));
                deliveries.push({ ...EMPTY }, { ...EMPTY });
                continue;
            }
            const args = [
                n.chainId,
                n.protocolAddress,
                n.tokenAddress,
                BigInt(member.nullifier),
                n.creditSharedKey,
            ] as const;
            const output = await this.seal(
                {
                    ...state,
                    note: {
                        ...n,
                        amount: remaining,
                        ...(options.credits[i]!.memo === undefined
                            ? {}
                            : { memo: options.credits[i]!.memo! }),
                        nonce: await deriveRemainderNonce(...args),
                    },
                },
                frame
            );
            outputs.push(output);
            remainders.push(output.commitment);
            recoveryAmounts.push(
                word((remaining + (await computeCreditRecoveryPad(...args))) % FIELD_MODULUS)
            );
            deliveries.push(...output.deliveries);
        }
        const plan = this.base(frame, "draw-credit");
        const params = {
            token: frame.context.tokenAddress,
            sources: [...sources]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([treeId, merkleRoot]) => ({ treeId, merkleRoot })),
            nullifiers: members.map((member) => member.nullifier),
            remainderCommitments: remainders,
            expiries: members.map((member) => member.input.state.note.expiry),
            recoveryAmounts,
            spender: getAddress(toBeHex(payout, 20) as Hex) as Hex,
            totalAmount: amounts.reduce((sum, amount) => sum + amount, 0n),
            deadline: frame.deadline,
        };
        plan.capacity = profile.maxSize;
        plan.credit = {
            inputs: members.map((member) => member.input),
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

    async cancel(options: CancelCreditPreparation): Promise<Result> {
        const frame = await this.#prepare.frame(options.deadline);
        const previous = await this.input(options.credit, "owner", frame);
        const n = previous.input.state.note;
        const plan = this.base(frame, "cancel-credit");
        const params = {
            token: frame.context.tokenAddress,
            source: previous.source,
            nullifier: previous.nullifier,
            owner: getAddress(toBeHex(n.ownerPayout, 20) as Hex) as Hex,
            amount: n.amount,
            deadline: frame.deadline,
        };
        plan.capacity = 1;
        plan.credit = { inputs: [previous.input], outputs: [], deliveries: [], cancel: params };
        plan.statement = WitnessBuilder.statement(
            "credit_cancel",
            cancelCreditPublicInputs(frame.context, params)
        );
        await this.#prepare.assertBlock(frame);
        return this.runtime.complete(plan);
    }
}
