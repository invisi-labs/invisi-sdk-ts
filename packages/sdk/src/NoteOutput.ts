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
} from "@invisi-labs/core";
import { AbiCoder, getAddress, hexlify, keccak256 } from "ethers";
import type { Delivery, Hex } from "@invisi-labs/protocol/contracts";
import { resolveRecipient } from "./resolve-recipient";
import type { PaymentOutput, PreparedOutput } from "./session/operation-types";

export interface NoteOutputContext {
    chainId: bigint;
    protocolAddress: Hex;
    tokenAddress: Hex;
}
export interface NoteOutputOptions extends PaymentOutput {
    context: NoteOutputContext;
    /** Required for a short 0x address; full 0i addresses carry receiving keys. */
    addressResolver?: ReceivingKeyLookup;
}

function nonceValue(value: bigint): bigint {
    if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS) {
        throw new RangeError("nonce must be a canonical BN254 field element");
    }
    return value;
}
function payloadCopy(value?: Uint8Array): Uint8Array {
    if (value === undefined) return new Uint8Array();
    if (!(value instanceof Uint8Array)) throw new TypeError("payload must be Uint8Array");
    return Uint8Array.from(value);
}

function deliveryFingerprint(delivery: Delivery): Hex {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [delivery.ciphertext, delivery.clue])
    ) as Hex;
}

/** An immutable, deployment-bound funds output, ready for any funds prepare* method. */
export class NoteOutput implements PaymentOutput {
    readonly to: string;
    readonly amount: bigint;
    readonly nonce: bigint;
    readonly identity: Hex;
    readonly commitment: Hex;
    /** Local corruption check for copyable delivery bytes; it does not authenticate storage. */
    readonly deliveryFingerprint: Hex;
    declare readonly payload: Uint8Array;
    /** Copyable material retained when transaction intents are persisted or repriced. */
    declare readonly preparedOutput: PreparedOutput;

    private constructor(output: PreparedOutput) {
        const saved = structuredClone(output);
        this.to = saved.address;
        this.amount = saved.note.amount;
        this.nonce = saved.note.nonce;
        this.identity = saved.identity;
        this.commitment = saved.commitment;
        this.deliveryFingerprint = deliveryFingerprint(saved.delivery);
        Object.defineProperties(this, {
            payload: { enumerable: true, get: () => payloadCopy(saved.note.payload) },
            preparedOutput: { enumerable: true, get: () => structuredClone(saved) },
        });
        Object.freeze(this);
    }

    static async create(options: NoteOutputOptions): Promise<NoteOutput> {
        if (
            typeof options.amount !== "bigint" ||
            options.amount <= 0n ||
            options.amount >= 1n << 128n
        ) {
            throw new RangeError("amount must be a positive uint128");
        }
        const nonce = nonceValue(options.nonce === undefined ? generateNonce() : options.nonce);
        const payload = payloadCopy(options.payload);
        const to = options.to;
        const amount = options.amount;
        const { chainId } = options.context;
        const protocolAddress = getAddress(options.context.protocolAddress);
        const tokenAddress = getAddress(options.context.tokenAddress);
        if (BigInt(protocolAddress) === 0n)
            throw new RangeError("protocol address must be nonzero");
        const recipient = await resolveRecipient(to, options.addressResolver, { field: "to" });
        const identity = await computeNoteIdentity(BigInt(recipient.walletIdentity), nonce);
        const note: Note = {
            chainId,
            protocolAddress: BigInt(protocolAddress),
            tokenAddress: BigInt(tokenAddress),
            walletIdentity: recipient.walletIdentity,
            amount,
            nonce,
            payload,
        };
        const commitment = await computeNoteCommitment(
            chainId,
            identity,
            note.tokenAddress,
            amount
        );
        const keys = recipient.getReceivingKeys();
        return new NoteOutput({
            note,
            identity,
            commitment,
            address: to,
            change: false,
            delivery: {
                ciphertext: hexlify(
                    await encryptPrivateTransferNote(keys.viewingPublicKey, note, {
                        chainId,
                        protocolAddress: note.protocolAddress,
                        outputCommitment: commitment,
                    })
                ) as Hex,
                clue: hexlify(createClue(keys.clueKey)) as Hex,
            },
        });
    }

    get note(): Note {
        return this.preparedOutput.note;
    }

    get delivery(): Delivery {
        return this.preparedOutput.delivery;
    }
}

/** Revalidate copyable output material before using it in a transaction context. */
export async function materializeNoteOutput(
    payment: PaymentOutput,
    context: NoteOutputContext,
    addressResolver?: ReceivingKeyLookup
): Promise<PreparedOutput> {
    const cached = (payment as Partial<NoteOutput>).preparedOutput;
    if (cached === undefined) {
        return (
            await NoteOutput.create({
                ...payment,
                context,
                ...(addressResolver ? { addressResolver } : {}),
            })
        ).preparedOutput;
    }
    const output = structuredClone(cached);
    if (
        deliveryFingerprint(output.delivery) !==
        (payment as Partial<NoteOutput>).deliveryFingerprint
    ) {
        throw new Error("note output delivery fingerprint mismatch");
    }
    const note = output.note;
    const nonce = nonceValue(payment.nonce!);
    if (
        note.chainId !== context.chainId ||
        note.protocolAddress !== BigInt(context.protocolAddress) ||
        note.tokenAddress !== BigInt(context.tokenAddress)
    )
        throw new Error("note output chain, protocol or token mismatch");
    if (
        output.address !== payment.to ||
        note.walletIdentity !== ReceivingAddress.parse(payment.to).walletIdentity ||
        note.amount !== payment.amount ||
        note.nonce !== nonce ||
        hexlify(payloadCopy(note.payload)) !== hexlify(payloadCopy(payment.payload))
    )
        throw new Error("note output material does not match payment intent");
    const identity = await computeNoteIdentity(BigInt(note.walletIdentity), nonce);
    const commitment = await computeNoteCommitment(
        context.chainId,
        identity,
        note.tokenAddress,
        note.amount
    );
    if (output.identity !== identity || output.commitment !== commitment) {
        throw new Error("note output identity or commitment mismatch");
    }
    return output;
}
