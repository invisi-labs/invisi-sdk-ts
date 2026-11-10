import { exportPaymentNote } from "../payment-note/export";
import {
    FIELD_MODULUS,
    ReceivingAddress,
    computeNoteCommitment,
    computeNoteIdentity,
    createClue,
    encryptPrivateTransferNote,
    generateNonce,
    type Note,
    type ReceivingKeyLookup,
} from "@invisi-labs/primitives";
import type { Delivery, Hex } from "@invisi-labs/protocol/contracts";
import { AbiCoder, getAddress, hexlify, keccak256 } from "ethers";
import { InvisiError } from "../errors";
import type { PreparedOutput } from "../transactions/operation-types";
import type { AddressLookup } from "./recipient-infrastructure";
import { resolveRecipient } from "./resolve-recipient";

import type {
    NoteOutputContext,
    NoteOutputRecipient,
    PaymentRequest,
    NoteOutputExecutionOptions,
} from "../payment-request/types";
export type {
    NoteOutputContext,
    NoteOutputRecipient,
    PaymentRequest,
    NoteOutputExecutionOptions,
} from "../payment-request/types";
import { encodePaymentRequest, decodePaymentRequest } from "../payment-request/codec";
import { assertRequestMatchesOutput } from "../payment-request/match-output";
import { applyExecutionOptions } from "../payment-request/execution";
function nonceValue(value: bigint): bigint {
    if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS)
        throw new RangeError("nonce must be a canonical BN254 field element");
    return value;
}
function identityValue(value: Hex): Hex {
    if (
        typeof value !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(value) ||
        BigInt(value) <= 0n ||
        BigInt(value) >= FIELD_MODULUS
    )
        throw new RangeError("identity must be a nonzero canonical BN254 field element");
    return value.toLowerCase() as Hex;
}
function payloadCopy(value?: Uint8Array): Uint8Array {
    if (value === undefined) return new Uint8Array();
    if (!(value instanceof Uint8Array)) throw new TypeError("payload must be Uint8Array");
    return Uint8Array.from(value);
}
function fingerprint(delivery: Delivery): Hex {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [delivery.ciphertext, delivery.clue])
    ) as Hex;
}
function checkedContext(context: NoteOutputContext): NoteOutputContext {
    if (typeof context.chainId !== "bigint" || context.chainId <= 0n)
        throw new RangeError("chainId must be positive");
    const protocolAddress = getAddress(context.protocolAddress) as Hex;
    const tokenAddress = getAddress(context.tokenAddress) as Hex;
    if (BigInt(protocolAddress) === 0n) throw new RangeError("protocol address must be nonzero");
    return { chainId: context.chainId, protocolAddress, tokenAddress };
}
function encrypted(recipient: NoteOutputRecipient): boolean {
    return (
        recipient.type === "invisi" || (recipient.type === "evm" && recipient.envelope !== false)
    );
}
function rejectLegacy(value: object): void {
    for (const key of [
        "expectedCommitment",
        "nonce",
        "envelope",
        "context",
        "to",
        "addressResolver",
        "addressLookup",
    ])
        if (key in value) throw new TypeError(`${key} is not a NoteOutput create option`);
}
const outputCreation = Symbol("NoteOutput.create");

/** Immutable output statement and optional recoverable opening. */
export class NoteOutput {
    readonly to: string;
    readonly ipp: string;
    readonly amount: bigint;
    readonly identity: Hex;
    readonly commitment: Hex;
    readonly deliveryFingerprint: Hex;
    /** Encrypted EVM delivery is resolved by preparation; the original offline intent stays pending. */
    readonly deliveryPending: boolean;
    declare readonly context: NoteOutputContext;
    declare readonly recipient: NoteOutputRecipient;
    declare readonly nonce: bigint | undefined;
    declare readonly payload: Uint8Array;
    declare readonly preparedOutput: PreparedOutput;
    private constructor(output: PreparedOutput, token: symbol, ipp: string) {
        if (token !== outputCreation)
            throw new TypeError("outputs must be created with NoteOutput.create");
        const saved = structuredClone(output);
        this.ipp = ipp;
        this.to = saved.address;
        this.amount = saved.amount;
        this.identity = saved.identity;
        this.commitment = saved.commitment;
        this.deliveryFingerprint = fingerprint(saved.delivery);
        this.deliveryPending = saved.deliveryPending === true;
        Object.defineProperties(this, {
            context: { enumerable: true, get: () => structuredClone(saved.context) },
            recipient: { enumerable: true, get: () => structuredClone(saved.recipient) },
            nonce: { enumerable: true, get: () => saved.note?.nonce },
            payload: { enumerable: true, get: () => payloadCopy(saved.note?.payload) },
            preparedOutput: { enumerable: true, get: () => structuredClone(saved) },
        });
        Object.freeze(this);
    }
    /** Private offline delivery data; does not assert that the output has been mined. */
    exportPaymentNote(): string {
        return exportPaymentNote(this.preparedOutput);
    }
    static async create(
        input: PaymentRequest | string,
        execution: NoteOutputExecutionOptions = {}
    ): Promise<NoteOutput> {
        if (typeof input !== "string") rejectLegacy(input);
        const request =
            typeof input === "string" ? decodePaymentRequest(input) : structuredClone(input);
        rejectLegacy(request);
        const options = applyExecutionOptions(request, execution);
        if (
            typeof options.amount !== "bigint" ||
            options.amount <= 0n ||
            options.amount >= 1n << 128n
        )
            throw new RangeError("amount must be a positive uint128");
        const context = checkedContext(options);
        const recipient = structuredClone(options.recipient);
        if (!recipient || !["evm", "invisi", "identity"].includes(recipient.type))
            throw new TypeError("invalid recipient type");
        if ("expectedCommitment" in recipient)
            throw new TypeError("expectedCommitment is not supported");
        const envelope = encrypted(recipient);
        if (!envelope && options.payload !== undefined)
            throw new TypeError("payload requires an encrypted envelope");
        let identity: Hex;
        let note: Note | undefined;
        let resolved: ReceivingAddress | undefined;
        let address: string;
        if (recipient.type === "identity") {
            if ("nonce" in recipient || "envelope" in recipient || "addressLookup" in recipient)
                throw new TypeError("identity recipient cannot specify nonce or envelope");
            identity = identityValue(recipient.identity);
            address = identity;
        } else {
            if (
                recipient.type === "evm" &&
                recipient.envelope !== undefined &&
                typeof recipient.envelope !== "boolean"
            )
                throw new TypeError("evm envelope must be boolean");
            if (recipient.type === "invisi" && "envelope" in recipient)
                throw new TypeError("invisi recipient is always encrypted");
            let parsed: ReceivingAddress;
            try {
                parsed = ReceivingAddress.parse(recipient.address);
            } catch (cause) {
                throw new InvisiError("INVALID_RECIPIENT", "Invalid recipient address", {
                    address: recipient.address,
                    field: "to",
                    cause,
                });
            }
            if ((recipient.type === "evm") !== (parsed.kind === "short"))
                throw new TypeError("recipient address type mismatch");
            resolved = parsed;
            if (recipient.type === "evm") {
                if (
                    recipient.addressLookup !== undefined &&
                    recipient.addressLookup !== "chain" &&
                    recipient.addressLookup !== "protocol-rpc"
                )
                    throw new TypeError("invalid recipient addressLookup");
                recipient.addressLookup ??= "protocol-rpc";
            } else if ("addressLookup" in recipient)
                throw new TypeError("addressLookup only applies to EVM recipients");
            const nonce = nonceValue(
                recipient.nonce === undefined ? generateNonce() : recipient.nonce
            );
            recipient.nonce = nonce;
            identity = await computeNoteIdentity(BigInt(resolved.ownerAddress), nonce);
            address = recipient.address;
            note = {
                chainId: context.chainId,
                protocolAddress: BigInt(context.protocolAddress),
                tokenAddress: BigInt(context.tokenAddress),
                ownerAddress: resolved.ownerAddress,
                amount: options.amount,
                nonce,
                payload: payloadCopy(options.payload),
            };
        }
        const commitment = await computeNoteCommitment(
            context.chainId,
            BigInt(context.protocolAddress),
            identity,
            BigInt(context.tokenAddress),
            options.amount
        );
        let delivery: Delivery = { ciphertext: "0x", clue: "0x" };
        if (envelope && recipient.type === "invisi") {
            const keys = resolved!.getReceivingKeys();
            delivery = {
                ciphertext: hexlify(
                    await encryptPrivateTransferNote(keys.viewingPublicKey, note!, {
                        chainId: context.chainId,
                        protocolAddress: BigInt(context.protocolAddress),
                        outputCommitment: commitment,
                    })
                ) as Hex,
                clue: hexlify(createClue(keys.clueKey)) as Hex,
            };
        }
        const ipp = typeof input === "string" ? input : encodePaymentRequest(request);
        return new NoteOutput(
            {
                context,
                recipient,
                amount: options.amount,
                ...(note ? { note } : {}),
                identity,
                commitment,
                delivery,
                ...(envelope && recipient.type === "evm" ? { deliveryPending: true as const } : {}),
                address,
                change: false,
            },
            outputCreation,
            ipp
        );
    }
    assertCommitment(expectedHex: Hex): void {
        if (
            typeof expectedHex !== "string" ||
            expectedHex.toLowerCase() !== this.commitment.toLowerCase()
        )
            throw new Error("note output commitment mismatch");
    }
    get note(): Note | undefined {
        return this.preparedOutput.note;
    }
    get delivery(): Delivery {
        return this.preparedOutput.delivery;
    }
}
export async function materializeNoteOutput(
    payment: NoteOutput,
    context: NoteOutputContext,
    lookup?: (source: AddressLookup) => ReceivingKeyLookup
): Promise<PreparedOutput> {
    if ("expectedCommitment" in payment) throw new TypeError("expectedCommitment is not supported");
    const cached = (payment as Partial<NoteOutput>).preparedOutput;
    if (cached === undefined) throw new TypeError("outputs must be created with NoteOutput.create");
    const output = structuredClone(cached);
    const expectedContext = checkedContext(context);
    const copied = payment as NoteOutput;
    for (const actual of [output.context, copied.context]) {
        if (
            !actual ||
            actual.chainId !== expectedContext.chainId ||
            BigInt(actual.protocolAddress) !== BigInt(expectedContext.protocolAddress) ||
            BigInt(actual.tokenAddress) !== BigInt(expectedContext.tokenAddress)
        )
            throw new Error("note output chain, protocol or token mismatch");
    }
    if (
        output.amount !== payment.amount ||
        output.address !== payment.to ||
        output.identity !== copied.identity ||
        output.commitment !== copied.commitment ||
        JSON.stringify(output.recipient, (_, v) => (typeof v === "bigint" ? v.toString() : v)) !==
            JSON.stringify(copied.recipient, (_, v) => (typeof v === "bigint" ? v.toString() : v))
    )
        throw new Error("note output material does not match payment intent");
    if (fingerprint(output.delivery) !== copied.deliveryFingerprint)
        throw new Error("note output delivery fingerprint mismatch");
    const hasCiphertext = output.delivery.ciphertext !== "0x";
    const hasClue = output.delivery.clue !== "0x";
    const pending = output.deliveryPending === true;
    if (
        copied.deliveryPending !== pending ||
        ("deliveryPending" in output && output.deliveryPending !== true)
    )
        throw new Error("note output pending delivery mismatch");
    if (
        hasCiphertext !== hasClue ||
        (pending
            ? hasCiphertext || output.recipient.type !== "evm" || !encrypted(output.recipient)
            : hasCiphertext !== encrypted(output.recipient))
    )
        throw new Error("note output delivery mode mismatch");
    const recipient = output.recipient;
    if ("expectedCommitment" in recipient) throw new Error("expectedCommitment is not supported");
    if (!encrypted(recipient) && payloadCopy(payment.payload).length !== 0)
        throw new Error("payload requires an encrypted envelope");
    if (recipient.type === "identity") {
        if (
            !/^0x[0-9a-fA-F]{64}$/.test(output.identity) ||
            output.address !== output.identity ||
            output.note ||
            "nonce" in recipient ||
            "envelope" in recipient ||
            "addressLookup" in recipient ||
            recipient.identity.toLowerCase() !== output.identity.toLowerCase()
        )
            throw new Error("opaque identity output material mismatch");
        identityValue(output.identity);
    } else {
        const note = output.note;
        const parsed = ReceivingAddress.parse(recipient.address);
        if (
            recipient.type === "evm" &&
            recipient.addressLookup !== undefined &&
            recipient.addressLookup !== "chain" &&
            recipient.addressLookup !== "protocol-rpc"
        )
            throw new Error("invalid recipient addressLookup");
        if (recipient.type === "invisi" && "addressLookup" in recipient)
            throw new Error("addressLookup only applies to EVM recipients");
        if (
            output.address !== recipient.address ||
            (recipient.type === "evm" &&
                recipient.envelope !== undefined &&
                typeof recipient.envelope !== "boolean") ||
            (recipient.type === "invisi" && "envelope" in recipient)
        )
            throw new Error("recipient material mismatch");
        if (
            !note ||
            note.chainId !== context.chainId ||
            note.protocolAddress !== BigInt(context.protocolAddress) ||
            note.tokenAddress !== BigInt(context.tokenAddress) ||
            note.ownerAddress !== parsed.ownerAddress ||
            note.amount !== output.amount ||
            note.nonce !== recipient.nonce ||
            note.nonce !== payment.nonce ||
            hexlify(payloadCopy(note.payload)) !== hexlify(payloadCopy(payment.payload))
        )
            throw new Error("note output opening does not match payment intent");
        if ((recipient.type === "evm") !== (parsed.kind === "short"))
            throw new Error("recipient type mismatch");
        if (
            (await computeNoteIdentity(BigInt(note.ownerAddress), nonceValue(note.nonce))) !==
            output.identity
        )
            throw new Error("note output identity mismatch");
    }
    if (
        typeof output.amount !== "bigint" ||
        output.amount <= 0n ||
        output.amount >= 1n << 128n ||
        (await computeNoteCommitment(
            context.chainId,
            BigInt(context.protocolAddress),
            output.identity,
            BigInt(context.tokenAddress),
            output.amount
        )) !== output.commitment
    )
        throw new Error("note output commitment mismatch");
    assertRequestMatchesOutput(payment.ipp, output);
    if (pending) {
        if (recipient.type !== "evm") throw new Error("only EVM outputs may have pending delivery");
        const resolved = await resolveRecipient(
            recipient.address,
            lookup?.(recipient.addressLookup ?? "protocol-rpc"),
            { field: "to" }
        );
        const keys = resolved.getReceivingKeys();
        output.delivery = {
            ciphertext: hexlify(
                await encryptPrivateTransferNote(keys.viewingPublicKey, output.note!, {
                    chainId: context.chainId,
                    protocolAddress: BigInt(context.protocolAddress),
                    outputCommitment: output.commitment,
                })
            ) as Hex,
            clue: hexlify(createClue(keys.clueKey)) as Hex,
        };
        delete output.deliveryPending;
    }
    return output;
}

/** Retain a validated factory output's resolved delivery in a copyable operation intent. */
export function resolvedOutputSnapshot(payment: NoteOutput, output: PreparedOutput): NoteOutput {
    const copy = structuredClone(payment);
    Object.assign(copy, {
        preparedOutput: structuredClone(output),
        deliveryFingerprint: fingerprint(output.delivery),
        deliveryPending: false,
    });
    return copy;
}
