import { normalizeNoteOwner, noteOwnerAddress } from "../../notes/note-owner";
import { mapPreparation } from "./parallel";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress } from "ethers/address";
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
    timestamp: bigint;
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
    readonly #rootReads = new Map<bigint, Promise<Membership>>();
    #inventory: Promise<import("../operation-types").PreparationInventory> | undefined;
    inventory() {
        return (this.#inventory ??= this.runtime.readInventory());
    }
    constructor(readonly runtime: PreparationRuntime<Result>) {}

    async frame(requested?: bigint, revocationFeeAmount?: bigint): Promise<PreparationFrame> {
        const { reader, options } = this.runtime;
        const [, block] = await Promise.all([
            this.runtime.preparationReads
                ? this.runtime.preparationReads.validateDeployment(options.protocol, reader, {
                      revocationFeeAmount,
                  })
                : options.protocol.validateDeployment(reader, { revocationFeeAmount }),
            reader.getLatestBlockNumber().then((number) => reader.getBlock(number)),
        ]);
        const timestamp =
            this.runtime.preparationTime && this.runtime.preparationTime > block.timestamp
                ? this.runtime.preparationTime
                : block.timestamp;
        const deadline = requested ?? timestamp + (options.transactionTTL ?? 300n);
        if (typeof deadline !== "bigint" || deadline < timestamp || deadline >= 1n << 64n) {
            throw new Error("invalid transaction deadline");
        }
        const state = await (this.runtime.readSummary
            ? this.runtime.readSummary()
            : this.inventory());
        if (state.invalidated) {
            throw new Error("wallet requires canonical resync");
        }
        for (const point of [state.observedThrough]) {
            if (
                point &&
                (point.number === block.number
                    ? block.hash
                    : (await reader.getBlock(point.number)).hash) !== point.hash
            ) {
                throw new Error("canonical wallet checkpoint changed; resync required");
            }
        }
        return {
            timestamp,
            context: {
                ...options.protocol.context,
                now: timestamp,
                timestamp,
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
        if (mode === "signature" && funding.deadline < frame.timestamp) {
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
        const first = this.#rootReads.get(input.treeId);
        if (first) {
            await first;
            return this.readMembership(input, frame);
        }
        const pending = this.readMembership(input, frame);
        this.#rootReads.set(input.treeId, pending);
        try {
            return await pending;
        } catch (error) {
            this.#rootReads.delete(input.treeId);
            throw error;
        }
    }

    private async readMembership(
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

    private async memberships(
        inputs: readonly { treeId: bigint; leafIndex: number; commitment: Hex }[],
        frame: PreparationFrame
    ): Promise<Membership[]> {
        const { options, reader } = this.runtime;
        const provider = options.protocolRpc;
        if (!provider) throw new MissingCapabilityError("Protocol RPC membership provider");
        if (provider.getMemberships && inputs.length) {
            const requests = inputs.map((input) => ({
                ...input,
                ...(this.#roots.has(input.treeId) ? { root: this.#roots.get(input.treeId)! } : {}),
            }));
            const proofs = await provider.getMemberships(frame.context, requests, frame.block);
            if (proofs.length !== inputs.length)
                throw Error("membership batch response length mismatch");
            const roots = new Map(this.#roots);
            for (let index = 0; index < inputs.length; index++) {
                const input = inputs[index]!,
                    proof = proofs[index]!;
                const root = roots.get(input.treeId);
                if (root && proof.root !== root)
                    throw Error("membership provider changed the pinned source root");
                roots.set(input.treeId, proof.root);
            }
            await mapPreparation(inputs, async (input, index) =>
                verifyMembership(reader, frame.context, frame.block, input, proofs[index]!)
            );
            for (const [treeId, root] of roots) this.#roots.set(treeId, root);
            return proofs.map((proof) => ({ ...proof, path: [...proof.path] }));
        }
        // A root that covers the highest selected leaf must seed each tree before older paths.
        const highest = new Map<bigint, (typeof inputs)[number]>();
        for (const input of inputs) {
            if (
                !highest.has(input.treeId) ||
                input.leafIndex > highest.get(input.treeId)!.leafIndex
            )
                highest.set(input.treeId, input);
        }
        const seeded = new Map<string, Membership>();
        await mapPreparation([...highest.values()], async (input) => {
            seeded.set(input.commitment, await this.membership(input, frame));
        });
        return mapPreparation(
            inputs,
            async (input) => seeded.get(input.commitment) ?? this.membership(input, frame)
        );
    }

    async selectFunds(target: bigint, frame: PreparationFrame, maxInputs = 190) {
        const { scope, options, reader } = this.runtime;
        const state = await this.inventory();
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
        const memberships = await this.memberships(selected, frame);
        const opened = await mapPreparation(selected, async (input, index) => {
            const note = normalizeNoteOwner(input.note);
            const c = frame.context;
            if (
                note.ownerAddress !== noteOwnerAddress(scope.ownerAddress) ||
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
            const proof = memberships[index]!;
            const path = [...proof.path];
            const root = proof.root;
            if (sources.has(input.treeId) && sources.get(input.treeId) !== root) {
                throw new Error("source roots do not share a canonical snapshot");
            }
            sources.set(input.treeId, root);
            return {
                input: {
                    note,
                    commitment: input.commitment,
                    treeId: input.treeId,
                    leafIndex: input.leafIndex,
                    path,
                },
                nullifier: await nullifier!.compute(
                    c.chainId,
                    BigInt(c.protocolAddress),
                    input.commitment,
                    input.note.nonce
                ),
            };
        });
        inputs.push(...opened.map((value) => value.input));
        nullifiers.push(...opened.map((value) => value.nullifier));
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
