import { deliveryHeader, deliveryCodec, validateDeliveryCiphertext } from "./delivery-codec";
import { normalizeCreditDeliveryState } from "./note-payload";
export { normalizeCreditDeliveryState } from "./note-payload";
import { secp256k1 } from "@noble/curves/secp256k1";
import { computeNoteIdentity, computeNoteCommitment } from "./commitment";
import { computeCreditCommitment, computeCreditSharedKeyHash } from "./creditCommitment";
import { FIELD_MODULUS } from "./random";
import type {
    CreditNote,
    CreditDeliveryState,
    ReceivingKeys,
    Note,
    ProtocolContext,
} from "./types";
import { assertNoteContext } from "./noteContext";

export type NoteBytes = `0x${string}` | Uint8Array;
export interface NoteEncryptionContext extends ProtocolContext {
    outputCommitment: `0x${string}`;
}
export interface NoteDecryptionContext extends NoteEncryptionContext {
    tokenAddress: bigint;
    ownerAddress: `0x${string}`;
}
export interface CreditNoteEncryptionContext extends NoteEncryptionContext {
    role: "owner" | "spender";
}
export interface CreditNoteDecryptionContext extends NoteDecryptionContext {
    role: "owner" | "spender";
}

// Minimal Web Crypto declarations avoid adding DOM/Node types to this package API.
type GcmParameters = {
    name: string;
    iv: ArrayBuffer;
    additionalData: ArrayBuffer;
    tagLength: number;
};
declare const crypto: {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    subtle: {
        importKey(
            format: string,
            data: ArrayBuffer,
            algorithm: string,
            extractable: boolean,
            usages: string[]
        ): Promise<unknown>;
        exportKey(format: "raw", key: unknown): Promise<ArrayBuffer>;
        deriveKey(
            parameters: { name: string; hash: string; salt: ArrayBuffer; info: ArrayBuffer },
            key: unknown,
            algorithm: { name: string; length: number },
            extractable: boolean,
            usages: string[]
        ): Promise<unknown>;
        encrypt(parameters: GcmParameters, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
        decrypt(parameters: GcmParameters, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
    };
};
const ascii = (value: string) => Uint8Array.from(value, (character) => character.charCodeAt(0));

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function bytes(value: NoteBytes, length: number): Uint8Array {
    let out: Uint8Array;
    if (typeof value === "string") {
        if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("invalid hexadecimal bytes");
        out = Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
    } else if (value instanceof Uint8Array) out = Uint8Array.from(value);
    else throw new Error("expected hexadecimal bytes or Uint8Array");
    if (out.length !== length) throw new Error(`expected ${length} bytes`);
    return out;
}
function uint(value: bigint, bits: number, name: string): void {
    if (value < 0n || value >= 1n << BigInt(bits))
        throw new RangeError(`${name} out of uint${bits} range`);
}
function field(value: bigint, name: string): void {
    if (value < 0n || value >= FIELD_MODULUS)
        throw new RangeError(`${name} out of BN254 field range`);
}
function encode(value: bigint, length = 32): Uint8Array {
    uint(value, length * 8, "encoded value");
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(value & 255n);
        value >>= 8n;
    }
    return out;
}
function decode(value: Uint8Array): bigint {
    return value.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}
function hexField(value: bigint): `0x${string}` {
    uint(value, 160, "owner address");
    return `0x${value.toString(16).padStart(40, "0")}`;
}
function validateContext(context: NoteEncryptionContext, tokenAddress: bigint): void {
    uint(context.chainId, 64, "chainId");
    uint(context.protocolAddress, 160, "protocolAddress");
    uint(tokenAddress, 160, "tokenAddress");
    field(BigInt(context.outputCommitment), "outputCommitment");
}
function aad(
    domain: Uint8Array,
    context: NoteEncryptionContext,
    tokenAddress: bigint,
    header: Uint8Array,
    role: number
): Uint8Array {
    validateContext(context, tokenAddress);
    return concat(
        domain,
        header,
        new Uint8Array([role]),
        encode(context.chainId, 8),
        encode(context.protocolAddress, 20),
        encode(tokenAddress, 20),
        encode(BigInt(context.outputCommitment))
    );
}
function validateNote(note: Note): void {
    uint(note.amount, 128, "amount");
    if (note.amount === 0n) throw new Error("amount must be positive");
    field(note.nonce, "nonce");
    uint(BigInt(note.ownerAddress), 160, "ownerAddress");
    if (BigInt(note.ownerAddress) === 0n) throw new Error("owner address must be positive");
    uint(note.tokenAddress, 160, "tokenAddress");
}
function validateCredit(note: CreditNote): void {
    uint(note.amount, 126, "amount");
    uint(note.expiry, 64, "expiry");
    uint(note.tokenAddress, 160, "tokenAddress");
    uint(BigInt(note.spenderWalletIdentity), 160, "spenderWalletIdentity");
    uint(BigInt(note.ownerWalletIdentity), 160, "ownerWalletIdentity");
    uint(note.spenderPayout, 160, "spenderPayout");
    uint(note.ownerPayout, 160, "ownerPayout");
    field(note.nonce, "nonce");
    field(note.creditSharedKey, "creditSharedKey");
    if (
        BigInt(note.spenderWalletIdentity) === 0n ||
        BigInt(note.ownerWalletIdentity) === 0n ||
        note.spenderPayout === 0n ||
        note.ownerPayout === 0n ||
        note.amount === 0n ||
        note.expiry === 0n ||
        note.creditSharedKey === 0n
    )
        throw new Error("Credit roles, payouts, amount, expiry and shared key must be positive");
}
async function noteCommitment(context: NoteEncryptionContext, note: Note): Promise<void> {
    validateContext(context, note.tokenAddress);
    assertNoteContext(note, context);
    validateNote(note);
    const commitment = await computeNoteCommitment(
        context.chainId,
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    if (BigInt(commitment) !== BigInt(context.outputCommitment))
        throw new Error("output commitment mismatch");
}
async function creditCommitment(context: NoteEncryptionContext, note: CreditNote): Promise<void> {
    validateContext(context, note.tokenAddress);
    assertNoteContext(note, context);
    validateCredit(note);
    const commitment = await computeCreditCommitment(
        context.chainId,
        note.spenderWalletIdentity,
        note.ownerWalletIdentity,
        note.spenderPayout,
        note.ownerPayout,
        note.tokenAddress,
        note.amount,
        note.nonce,
        note.expiry,
        await computeCreditSharedKeyHash(note.creditSharedKey),
        note
    );
    if (BigInt(commitment) !== BigInt(context.outputCommitment))
        throw new Error("credit commitment mismatch");
}
function privateKey(value: NoteBytes): Uint8Array {
    const key = bytes(value, 32);
    if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error("invalid viewing private key");
    return key;
}
function publicKey(value: NoteBytes): Uint8Array {
    const key = bytes(value, 33);
    if (key[0] !== 2 && key[0] !== 3) throw new Error("expected compressed secp256k1 public key");
    // Parsing checks that the compressed x coordinate is on the curve.
    secp256k1.ProjectivePoint.fromHex(key);
    return key;
}
/** Compressed secp256k1 viewing key (33 bytes), independent of spending authority. */
export function viewingPublicKey(key: NoteBytes): Uint8Array {
    return secp256k1.getPublicKey(privateKey(key), true);
}
function random(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}
function ephemeralKey(): Uint8Array {
    for (;;) {
        const key = random(32);
        if (secp256k1.utils.isValidPrivateKey(key)) return key;
    }
}
// ArrayBuffer copies keep browser BufferSource types independent of Node Buffers.
const buffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
async function derivedKey(
    key: Uint8Array,
    peer: Uint8Array,
    header: Uint8Array,
    recipient: Uint8Array,
    domain: Uint8Array,
    extractable = false
) {
    // Node's computeSecret returns the raw shared point X coordinate (32 bytes).
    const secret = secp256k1.getSharedSecret(key, peer, true).slice(1);
    const material = await crypto.subtle.importKey("raw", buffer(secret), "HKDF", false, [
        "deriveKey",
    ]);
    try {
        return await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: buffer(header.slice(34, 50)),
                info: buffer(concat(domain, header.slice(1, 34), recipient)),
            },
            material,
            { name: "AES-GCM", length: 256 },
            extractable,
            ["encrypt", "decrypt"]
        );
    } finally {
        secret.fill(0);
    }
}
async function seal(
    viewingKey: NoteBytes,
    plaintext: Uint8Array,
    context: NoteEncryptionContext,
    tokenAddress: bigint,
    headerByte: number,
    role: number
): Promise<Uint8Array> {
    const peer = publicKey(viewingKey),
        key = ephemeralKey();
    const salt = random(16),
        iv = random(12),
        domain = deliveryDomain(headerByte);
    const header = concat(
        new Uint8Array([headerByte]),
        secp256k1.getPublicKey(key, true),
        salt,
        iv
    );
    const additionalData = aad(domain, context, tokenAddress, header, role);
    try {
        const encrypted = await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: buffer(iv),
                additionalData: buffer(additionalData),
                tagLength: 128,
            },
            await derivedKey(key, peer, header, peer, domain),
            buffer(plaintext)
        );
        return concat(header, new Uint8Array(encrypted));
    } finally {
        key.fill(0);
        plaintext.fill(0);
    }
}
async function open(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext,
    headerByte: number,
    role: number,
    payloadKey = false
): Promise<Uint8Array> {
    const data = envelopeBytes(envelope, deliveryCodec(headerByte).kind === "credit");
    if (data[0] !== headerByte) throw new Error("unsupported envelope version");
    const domain = deliveryDomain(headerByte);
    const additionalData = aad(domain, context, context.tokenAddress, data.slice(0, 62), role);
    const localKey = payloadKey ? bytes(key, 32) : privateKey(key);
    try {
        const aes = payloadKey
            ? await crypto.subtle.importKey("raw", buffer(bytes(key, 32)), "AES-GCM", false, [
                  "decrypt",
              ])
            : await derivedKey(
                  localKey,
                  publicKey(data.slice(1, 34)),
                  data.slice(0, 62),
                  secp256k1.getPublicKey(localKey, true),
                  domain
              );
        const decrypted = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: buffer(data.slice(50, 62)),
                additionalData: buffer(additionalData),
                tagLength: 128,
            },
            aes,
            buffer(data.slice(62))
        );
        return new Uint8Array(decrypted);
    } finally {
        localKey.fill(0);
    }
}
function copyPayload(value: Uint8Array, codec: { minimum: number; maximum: number }): Uint8Array {
    if (!(value instanceof Uint8Array)) throw new Error("codec encode must return Uint8Array");
    if (value.length + 78 < codec.minimum || value.length + 78 > codec.maximum)
        throw new Error("invalid codec payload length");
    return Uint8Array.from(value);
}
function deliveryDomain(headerByte: number): Uint8Array {
    return ascii(deliveryCodec(headerByte).domain);
}

/** SDK v1 funds envelope with a fixed financial prefix and opaque application bytes. */
export async function encryptPrivateTransferNote(
    viewingKey: NoteBytes,
    note: Note,
    context: NoteEncryptionContext
): Promise<Uint8Array> {
    const scopedNote = structuredClone(note),
        scopedContext = { ...context };
    const codec = deliveryCodec(deliveryHeader("funds"));
    if (codec.kind !== "funds") throw new Error("unexpected envelope kind");
    await noteCommitment(scopedContext, scopedNote);
    const plaintext = copyPayload(codec.encode(structuredClone(scopedNote)), codec);
    return seal(
        viewingKey,
        plaintext,
        scopedContext,
        scopedNote.tokenAddress,
        deliveryHeader("funds"),
        0
    );
}
/** Authenticates the context and output commitment before returning the ordinary note. */
async function readNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext,
    payloadKey = false
): Promise<Note & { payload: Uint8Array }> {
    const authenticatedContext = { ...context };
    const data = envelopeBytes(envelope, false);
    const headerByte = data[0]!;
    const plain = await open(key, data, authenticatedContext, headerByte, 0, payloadKey);
    try {
        const codec = deliveryCodec(headerByte);
        if (codec.kind !== "funds") throw new Error("unexpected envelope kind");
        const note = structuredClone(
            codec.decode(plain, Object.freeze({ ...authenticatedContext }))
        );

        if (BigInt(note.ownerAddress) !== BigInt(authenticatedContext.ownerAddress))
            throw new Error("recipient owner address mismatch");
        if (note.tokenAddress !== authenticatedContext.tokenAddress)
            throw new Error("note token context mismatch");
        await noteCommitment(authenticatedContext, note);
        return note;
    } finally {
        plain.fill(0);
    }
}
function creditRole(role: string): number {
    if (role !== "owner" && role !== "spender")
        throw new Error("Credit role must be owner or spender");
    return role === "owner" ? 1 : 2;
}
function matchCreditRecipient(
    state: CreditDeliveryState,
    role: "owner" | "spender",
    recipient: Uint8Array
): void {
    const keys = role === "owner" ? state.ownerReceivingKeys : state.spenderReceivingKeys;
    if (!keys.viewingPublicKey.every((value, index) => value === recipient[index]))
        throw new Error("recipient receiving key mismatch");
}
/** SDK v1 Credit envelope with a fixed recovery prefix and opaque application bytes. */
export async function encryptCreditNote(
    viewingKey: NoteBytes,
    state: CreditDeliveryState,
    context: CreditNoteEncryptionContext
): Promise<Uint8Array> {
    const scopedState = normalizeCreditDeliveryState(state),
        scopedNote = scopedState.note;
    const scopedContext = { ...context };
    const codec = deliveryCodec(deliveryHeader("credit"));
    if (codec.kind !== "credit") throw new Error("unexpected envelope kind");
    creditRole(scopedContext.role);
    matchCreditRecipient(scopedState, scopedContext.role, publicKey(viewingKey));
    await creditCommitment(scopedContext, scopedNote);
    const plaintext = copyPayload(codec.encode(structuredClone(scopedState)), codec);
    return seal(
        viewingKey,
        plaintext,
        scopedContext,
        scopedNote.tokenAddress,
        deliveryHeader("credit"),
        creditRole(scopedContext.role)
    );
}
/** Authenticates the complete Credit header, context and output commitment. */
async function readCredit(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext,
    payloadKey = false
): Promise<CreditDeliveryState & { note: CreditNote & { payload: Uint8Array } }> {
    const authenticatedContext = { ...context };
    const data = envelopeBytes(envelope, true);
    const plain = await open(
        key,
        data,
        authenticatedContext,
        data[0]!,
        creditRole(authenticatedContext.role),
        payloadKey
    );
    try {
        const codec = deliveryCodec(data[0]!);
        if (codec.kind !== "credit") throw new Error("unexpected envelope kind");
        const state = normalizeCreditDeliveryState(
            structuredClone(codec.decode(plain, Object.freeze({ ...authenticatedContext })))
        );
        const note = state.note;
        if (
            BigInt(
                authenticatedContext.role === "owner"
                    ? note.ownerWalletIdentity
                    : note.spenderWalletIdentity
            ) !== BigInt(authenticatedContext.ownerAddress)
        )
            throw new Error("recipient owner address mismatch");

        if (!payloadKey)
            matchCreditRecipient(state, authenticatedContext.role, viewingPublicKey(key));
        if (note.tokenAddress !== authenticatedContext.tokenAddress)
            throw new Error("Credit token context mismatch");
        await creditCommitment(authenticatedContext, note);
        return {
            ...state,
            note: { ...state.note, payload: Uint8Array.from(state.note.payload ?? []) },
        };
    } finally {
        plain.fill(0);
    }
}

/** Authenticated recipient decryption. Application payload bytes are never decoded here. */
export function decryptPrivateTransferNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note & { payload: Uint8Array }> {
    return readNote(key, envelope, context);
}
/** Authenticated Credit decryption, including role and historical receiving keys. */
export function decryptCreditNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext
): Promise<CreditDeliveryState & { note: CreditNote & { payload: Uint8Array } }> {
    return readCredit(key, envelope, context);
}

// Internal disclosure primitives. Public callers use Disclosure or ViewingCapability.
export function decryptNotePayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note & { payload: Uint8Array }> {
    return readNote(key, envelope, context, true);
}

export function decryptCreditPayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext
): Promise<CreditDeliveryState & { note: CreditNote & { payload: Uint8Array } }> {
    return readCredit(key, envelope, context, true);
}

export async function exportPayloadKey(
    key: NoteBytes,
    envelope: NoteBytes,
    credit: boolean
): Promise<Uint8Array> {
    const data = envelopeBytes(envelope, credit);

    const localKey = privateKey(key);
    try {
        const aes = await derivedKey(
            localKey,
            publicKey(data.slice(1, 34)),
            data.slice(0, 62),
            viewingPublicKey(localKey),
            deliveryDomain(data[0]!),
            true
        );
        return new Uint8Array(await crypto.subtle.exportKey("raw", aes));
    } finally {
        localKey.fill(0);
    }
}

function envelopeBytes(value: NoteBytes, credit: boolean): Uint8Array {
    return validateDeliveryCiphertext(value, credit ? "credit" : "funds");
}
