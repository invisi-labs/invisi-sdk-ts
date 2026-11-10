import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress } from "ethers";
import { InvisiError } from "../../errors";
import { NoteOutput, materializeNoteOutput } from "../../notes/NoteOutput";
import { recipientLookup } from "../../notes/recipient-infrastructure";

import {
    MissingCapabilityError,
    computeNoteCommitment,
    computeNoteIdentity,
} from "@invisi-labs/primitives";
import {
    normalizeFunding,
    type CanonicalBlock,
    type FundingInput,
    type Membership,
    type TransactionContext,
} from "@invisi-labs/protocol";
import { type NoteMembership } from "@invisi-labs/prover";
import { verifyMembership } from "../../discovery/membership";
import type {
    FundingSource,
    OperationPlan,
    PreparationRuntime,
    PreparedOutput,
} from "../operation-types";
import type { NoteRecord } from "../records";
import { selectNotes, type SelectableNote } from "./selection";

export interface PreparationFrame {
    context: TransactionContext;
    block: CanonicalBlock;
    deadline: bigint;
}

export function positiveAmount(value: bigint, bits = 128): bigint {
    if (typeof value !== "bigint" || value <= 0n || value >= 1n << BigInt(bits)) {
        throw new Error(`amount must be a positive uint${bits}`);
    }
    return value;
}

/** Reject non-byte JavaScript inputs before copying; empty bytes explicitly clear metadata. */
export function copyApplicationPayload(value?: Uint8Array): Uint8Array {
    if (value === undefined) return new Uint8Array();
    if (!(value instanceof Uint8Array)) throw new TypeError("payload must be Uint8Array");
    return Uint8Array.from(value);
}

/** Preserve the offending payment position even when summing transfer amounts first. */
export function positiveOutputAmount(payment: NoteOutput, outputIndex?: number): bigint {
    try {
        return positiveAmount(payment.amount);
    } catch (cause) {
        throw new InvisiError(
            "PREPARATION_FAILED",
            cause instanceof Error ? cause.message : "Invalid output amount",
            {
                address: payment.to,
                field: "amount",
                ...(outputIndex === undefined ? {} : { outputIndex }),
                cause,
            }
        );
    }
}

/** Shared local preparation checks; private witnesses never enter this object's public records. */
export class Preparation<Result> {
    readonly #roots = new Map<bigint, Hex>();
    constructor(readonly runtime: PreparationRuntime<Result>) {}

    async frame(requested?: bigint): Promise<PreparationFrame> {
        const { reader, options } = this.runtime;
        await options.protocol.validateDeployment(reader);
        const block = await reader.getBlock(await reader.getLatestBlockNumber());
        const deadline = requested ?? block.timestamp + (options.transactionTTL ?? 300n);
        if (typeof deadline !== "bigint" || deadline < block.timestamp || deadline >= 1n << 64n) {
            throw new Error("invalid transaction deadline");
        }
        const state = await this.runtime.readInventory();
        if (state.invalidated) {
            throw new Error("wallet requires canonical resync");
        }
        for (const point of [state.observedThrough]) {
            if (point && (await reader.getBlock(point.number)).hash !== point.hash) {
                throw new Error("canonical wallet checkpoint changed; resync required");
            }
        }
        return {
            context: {
                ...options.protocol.context,
                now: block.timestamp,
                timestamp: block.timestamp,
            },
            block,
            deadline,
        };
    }

    async assertBlock(frame: PreparationFrame): Promise<void> {
        if ((await this.runtime.reader.getBlock(frame.block.number)).hash !== frame.block.hash) {
            throw new Error("canonical block changed while preparing");
        }
    }

    async funding(
        source: FundingSource | undefined,
        frame: PreparationFrame
    ): Promise<{ funding: FundingInput; fundingMode: OperationPlan["fundingMode"] }> {
        if (!source) {
            return { funding: {}, fundingMode: "none" };
        }
        positiveAmount(source.amount);
        const payer = getAddress(source.payer) as Hex;
        const mode = source.authorization ?? "signature";
        if (BigInt(payer) === 0n) {
            throw new Error("funding payer must be nonzero");
        }
        if (mode !== "signature" && mode !== "caller") {
            throw new Error("invalid funding authorization mode");
        }
        if (mode === "caller" && (source.sigNonce || source.deadline)) {
            throw new Error("caller funding uses zero nonce/deadline");
        }
        const funding = normalizeFunding({
            payer,
            amount: source.amount,
            sigNonce:
                mode === "caller"
                    ? 0n
                    : (source.sigNonce ??
                      (await this.runtime.reader.getFundingNonce(
                          frame.context,
                          payer,
                          frame.block
                      ))),
            deadline: mode === "caller" ? 0n : (source.deadline ?? frame.deadline),
            ...(source.permit ? { permit: structuredClone(source.permit) } : {}),
        });
        if (mode === "signature" && funding.deadline < frame.block.timestamp) {
            throw new Error("funding authorization deadline has expired");
        }
        return { funding, fundingMode: mode };
    }

    async change(amount: bigint, context: TransactionContext): Promise<PreparedOutput> {
        const address =
            this.runtime.changeAddress ??
            this.runtime.options.wallet.getReceivingAddress().toString();
        try {
            const output = await NoteOutput.create({
                chainId: context.chainId,
                protocolAddress: context.protocolAddress,
                tokenAddress: context.tokenAddress,
                amount,
                recipient: address.startsWith("0i")
                    ? { type: "invisi", address }
                    : { type: "evm", address },
            });
            return await this.output(output, context, true);
        } catch (cause) {
            if (cause instanceof InvisiError)
                throw new InvisiError(cause.code, cause.message, {
                    address,
                    field: "changeAddress",
                    ...(cause.capability ? { capability: cause.capability } : {}),
                    cause: cause.cause ?? cause,
                });
            throw new InvisiError(
                "PREPARATION_FAILED",
                cause instanceof Error ? cause.message : "Change output preparation failed",
                { address, field: "changeAddress", cause }
            );
        }
    }

    async output(
        payment: NoteOutput,
        context: TransactionContext,
        change = false,
        outputIndex?: number
    ): Promise<PreparedOutput> {
        try {
            positiveOutputAmount(payment, outputIndex);
            const output = await materializeNoteOutput(payment, context, (source) =>
                recipientLookup(this.runtime.options, source)
            );
            return { ...output, change };
        } catch (cause) {
            if (cause instanceof InvisiError) {
                throw new InvisiError(cause.code, cause.message, {
                    address: cause.address ?? payment.to,
                    field: change ? "changeAddress" : (cause.field ?? "to"),
                    ...(outputIndex === undefined ? {} : { outputIndex }),
                    ...(cause.capability ? { capability: cause.capability } : {}),
                    cause: cause.cause ?? cause,
                });
            }
            throw new InvisiError(
                "PREPARATION_FAILED",
                cause instanceof Error ? cause.message : "Output preparation failed",
                {
                    address: payment.to,
                    field: change ? "changeAddress" : "to",
                    ...(outputIndex === undefined ? {} : { outputIndex }),
                    cause,
                }
            );
        }
    }

    async membership(
        input: { treeId: bigint; leafIndex: number; commitment: Hex },
        frame: PreparationFrame
    ): Promise<Membership> {
        const { options, reader } = this.runtime;
        if (!options.protocolRpc)
            throw new MissingCapabilityError("Protocol RPC membership provider");
        const root = this.#roots.get(input.treeId);
        const proof = await options.protocolRpc.getMembership(
            frame.context,
            {
                ...input,
                ...(root ? { root } : {}),
            },
            frame.block
        );
        if (root && proof.root !== root)
            throw new Error("membership provider changed the pinned source root");
        await verifyMembership(reader, frame.context, frame.block, input, proof);
        this.#roots.set(input.treeId, proof.root);
        return { ...proof, path: [...proof.path] };
    }

    async selectFunds(target: bigint, frame: PreparationFrame, maxInputs = 190) {
        const { scope, options, reader } = this.runtime;
        const state = await this.runtime.readInventory();
        if (state.invalidated) {
            throw new Error("wallet requires canonical resync");
        }
        const need = target > 0n ? target : 0n;
        const nullifier = options.wallet.exportNullifier();
        const reserved = new Set(Object.keys(state.reservations));
        const eligible = Object.values(state.notes).filter(
            (note) =>
                note.note.tokenAddress === BigInt(frame.context.tokenAddress) &&
                note.spent === "unspent" &&
                !reserved.has(note.commitment)
        );
        const byId = new Map(eligible.map((note) => [note.commitment, note]));
        const choices = this.runtime.inputSelection
            ? [...this.runtime.inputSelection]
            : this.runtime.explicitInputs
              ? eligible.map((note) => note.commitment)
              : need > 0n && options.coinSelector
                ? await options.coinSelector.select(storedCandidates(eligible), need)
                : selectNotes(eligible, need, reserved).map((note) => note.commitment);
        if (
            !Array.isArray(choices) ||
            new Set(choices).size !== choices.length ||
            choices.some((id) => !byId.has(id))
        ) {
            throw new Error("invalid or duplicate coin selection");
        }
        const selected = choices.map((id) => structuredClone(byId.get(id)!));
        const amount = selected.reduce((sum, input) => sum + input.note.amount, 0n);
        if (amount < need) {
            throw new Error("coin selection has insufficient verified funds");
        }
        if (selected.length > maxInputs || amount >= 1n << 135n) {
            throw new Error("coin selection exceeds transaction capacity");
        }
        const inputs: Array<NoteMembership & { commitment: Hex }> = [];
        const sources = new Map<bigint, Hex>();
        const nullifiers: Hex[] = [];
        for (const input of selected) {
            const note = input.note;
            const c = frame.context;
            if (
                note.ownerAddress !== scope.ownerAddress ||
                note.chainId !== c.chainId ||
                note.protocolAddress !== BigInt(c.protocolAddress) ||
                note.tokenAddress !== BigInt(c.tokenAddress) ||
                (await computeNoteCommitment(
                    c.chainId,
                    BigInt(c.protocolAddress),
                    await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
                    note.tokenAddress,
                    note.amount
                )) !== input.commitment
            ) {
                throw new Error("selected input preimage/context mismatch");
            }
            const proof = await this.membership(input, frame);
            const path = [...proof.path];
            const root = proof.root;
            if (sources.has(input.treeId) && sources.get(input.treeId) !== root) {
                throw new Error("source roots do not share a canonical snapshot");
            }
            sources.set(input.treeId, root);
            inputs.push({
                note,
                commitment: input.commitment,
                treeId: input.treeId,
                leafIndex: input.leafIndex,
                path,
            });
            nullifiers.push(
                await nullifier!.compute(
                    c.chainId,
                    BigInt(c.protocolAddress),
                    input.commitment,
                    input.note.nonce
                )
            );
        }
        await this.assertUnspent(nullifiers, frame);
        return {
            inputs,
            sources: [...sources]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([treeId, merkleRoot]) => ({ treeId, merkleRoot })),
            nullifiers,
            amount,
        };
    }

    async assertUnspent(nullifiers: readonly Hex[], frame: PreparationFrame): Promise<void> {
        if (nullifiers.length) {
            const spent = await this.runtime.reader.isSpent(frame.context, nullifiers, frame.block);
            if (spent.length !== nullifiers.length || spent.some((value) => value !== false)) {
                throw new Error("selected input spent or invalid spent-state response");
            }
        }
    }
}

// Managed custom selectors retain access to receipt metadata. Explicit inputs
// use their own exact selection and never pass fabricated metadata to a selector.
function storedCandidates(inputs: readonly SelectableNote[]): NoteRecord[] {
    const records = inputs.filter(
        (input): input is NoteRecord =>
            "blockNumber" in input &&
            typeof input.blockNumber === "bigint" &&
            "blockHash" in input &&
            typeof input.blockHash === "string"
    );
    if (records.length !== inputs.length)
        throw new Error("custom coin selection requires stored receipt metadata");
    return structuredClone(records);
}
