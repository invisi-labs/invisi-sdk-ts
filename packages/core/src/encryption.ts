import { encodeMemo } from "./memo";
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
import { validateClueKey } from "./fmd";

export type NoteBytes = `0x${string}` | Uint8Array;
export interface NoteEncryptionContext extends ProtocolContext {
    outputCommitment: `0x${string}`;
}
export interface NoteDecryptionContext extends NoteEncryptionContext {
    tokenAddress: bigint;
    walletIdentity: `0x${string}`;
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
const NOTE_DOMAIN = ascii("Invisi.NoteDelivery.v2");
const CREDIT_DOMAIN = ascii("Invisi.CreditDelivery.v2");

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
    uint(BigInt(note.walletIdentity), 160, "walletIdentity");
    if (BigInt(note.walletIdentity) === 0n) throw new Error("wallet identity must be positive");
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
        await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce),
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
        await computeCreditSharedKeyHash(note.creditSharedKey)
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
    version: number,
    role: number
): Promise<Uint8Array> {
    const peer = publicKey(viewingKey),
        key = ephemeralKey();
    const salt = random(16),
        iv = random(12),
        domain = version === 2 ? NOTE_DOMAIN : CREDIT_DOMAIN;
    const header = concat(new Uint8Array([version]), secp256k1.getPublicKey(key, true), salt, iv);
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
    version: number,
    role: number,
    payloadKey = false
): Promise<Uint8Array> {
    const data = envelopeBytes(envelope, version !== 2);
    if (data[0] !== version) throw new Error("unsupported envelope version");
    const domain = version === 2 ? NOTE_DOMAIN : CREDIT_DOMAIN;
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
/** Funds envelope (160..416 bytes), with fresh ephemeral key, salt and IV. */
export async function encryptPrivateTransferNote(
    viewingKey: NoteBytes,
    note: Note,
    context: NoteEncryptionContext
): Promise<Uint8Array> {
    const memo = encodeMemo(note.memo);
    const scopedNote = { ...note };
    const scopedContext = { ...context };
    await noteCommitment(scopedContext, scopedNote);
    return seal(
        viewingKey,
        concat(
            encode(BigInt(scopedNote.walletIdentity)),
            encode(scopedNote.amount, 16),
            encode(scopedNote.nonce),
            encode(BigInt(memo.length), 2),
            memo
        ),
        scopedContext,
        scopedNote.tokenAddress,
        2,
        0
    );
}
/** Authenticates the context and output commitment before returning the ordinary note. */
async function readNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext,
    payloadKey = false
): Promise<Note> {
    const authenticatedContext = { ...context };
    const plain = await open(key, envelope, authenticatedContext, 2, 0, payloadKey);
    try {
        const note = {
            chainId: authenticatedContext.chainId,
            protocolAddress: authenticatedContext.protocolAddress,
            tokenAddress: authenticatedContext.tokenAddress,
            walletIdentity: hexField(decode(plain.slice(0, 32))),
            amount: decode(plain.slice(32, 48)),
            nonce: decode(plain.slice(48, 80)),
            ...readMemo(plain, 80),
        };
        if (BigInt(note.walletIdentity) !== BigInt(authenticatedContext.walletIdentity))
            throw new Error("recipient wallet identity mismatch");
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
function receivingKeys(keys: ReceivingKeys): ReceivingKeys {
    if (!keys || typeof keys !== "object") throw new TypeError("receiving keys required");
    const viewingPublicKey = publicKey(keys.viewingPublicKey),
        clueKey = bytes(keys.clueKey, 32);
    validateClueKey(clueKey);
    return { viewingPublicKey, clueKey };
}
/** Copy and validate both public key snapshots without exporting any spending material. */
export function normalizeCreditDeliveryState(state: CreditDeliveryState): CreditDeliveryState {
    if (!state || typeof state !== "object" || !state.note || typeof state.note !== "object")
        throw new TypeError("complete Credit delivery state required");
    const { memo, ...note } = state.note;
    const encodedMemo = encodeMemo(memo);
    return {
        note: { ...note, ...(encodedMemo.length === 0 ? {} : { memo: encodedMemo }) },
        ownerReceivingKeys: receivingKeys(state.ownerReceivingKeys),
        spenderReceivingKeys: receivingKeys(state.spenderReceivingKeys),
    };
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
/** Self-contained Credit envelope (402..658 bytes), authenticated for its recipient role. */
export async function encryptCreditNote(
    viewingKey: NoteBytes,
    state: CreditDeliveryState,
    context: CreditNoteEncryptionContext
): Promise<Uint8Array> {
    const scopedState = normalizeCreditDeliveryState(state),
        scopedNote = scopedState.note;
    const scopedContext = { ...context };
    const memo = encodeMemo(scopedNote.memo);
    creditRole(scopedContext.role);
    matchCreditRecipient(scopedState, scopedContext.role, publicKey(viewingKey));
    await creditCommitment(scopedContext, scopedNote);
    return seal(
        scopedState[scopedContext.role === "owner" ? "ownerReceivingKeys" : "spenderReceivingKeys"]
            .viewingPublicKey,
        concat(
            encode(BigInt(scopedNote.spenderWalletIdentity)),
            encode(BigInt(scopedNote.ownerWalletIdentity)),
            encode(scopedNote.spenderPayout, 20),
            encode(scopedNote.ownerPayout, 20),
            encode(scopedNote.amount, 16),
            encode(scopedNote.nonce),
            encode(scopedNote.expiry, 8),
            encode(scopedNote.creditSharedKey),
            scopedState.ownerReceivingKeys.viewingPublicKey,
            scopedState.ownerReceivingKeys.clueKey,
            scopedState.spenderReceivingKeys.viewingPublicKey,
            scopedState.spenderReceivingKeys.clueKey,
            encode(BigInt(memo.length), 2),
            memo
        ),
        scopedContext,
        scopedNote.tokenAddress,
        4,
        creditRole(scopedContext.role)
    );
}
/** Authenticates the complete Credit header, context and output commitment. */
async function readCredit(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext,
    payloadKey = false
): Promise<CreditDeliveryState> {
    const authenticatedContext = { ...context };
    const plain = await open(
        key,
        envelope,
        authenticatedContext,
        4,
        creditRole(authenticatedContext.role),
        payloadKey
    );
    try {
        const note = {
            chainId: authenticatedContext.chainId,
            protocolAddress: authenticatedContext.protocolAddress,
            spenderWalletIdentity: hexField(decode(plain.slice(0, 32))),
            ownerWalletIdentity: hexField(decode(plain.slice(32, 64))),
            spenderPayout: decode(plain.slice(64, 84)),
            ownerPayout: decode(plain.slice(84, 104)),
            tokenAddress: authenticatedContext.tokenAddress,
            amount: decode(plain.slice(104, 120)),
            nonce: decode(plain.slice(120, 152)),
            expiry: decode(plain.slice(152, 160)),
            creditSharedKey: decode(plain.slice(160, 192)),
            ...readMemo(plain, 322),
        };
        if (
            BigInt(
                authenticatedContext.role === "owner"
                    ? note.ownerWalletIdentity
                    : note.spenderWalletIdentity
            ) !== BigInt(authenticatedContext.walletIdentity)
        )
            throw new Error("recipient wallet identity mismatch");
        const state = normalizeCreditDeliveryState({
            note,
            ownerReceivingKeys: {
                viewingPublicKey: plain.slice(192, 225),
                clueKey: plain.slice(225, 257),
            },
            spenderReceivingKeys: {
                viewingPublicKey: plain.slice(257, 290),
                clueKey: plain.slice(290, 322),
            },
        });
        if (!payloadKey)
            matchCreditRecipient(state, authenticatedContext.role, viewingPublicKey(key));
        await creditCommitment(authenticatedContext, note);
        return state;
    } finally {
        plain.fill(0);
    }
}

/** Authenticated recipient decryption, including the output commitment. */
export function decryptPrivateTransferNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note> {
    return readNote(key, envelope, context);
}

/** Authenticated Credit decryption, including role and historical receiving keys. */
export function decryptCreditNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext
): Promise<CreditDeliveryState> {
    return readCredit(key, envelope, context);
}

// Internal disclosure primitives. Public callers use Disclosure or ViewingCapability.
export function decryptNotePayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note> {
    return readNote(key, envelope, context, true);
}

export function decryptCreditPayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditNoteDecryptionContext
): Promise<CreditDeliveryState> {
    return readCredit(key, envelope, context, true);
}

export async function exportPayloadKey(
    key: NoteBytes,
    envelope: NoteBytes,
    credit: boolean
): Promise<Uint8Array> {
    const data = envelopeBytes(envelope, credit);
    if (data[0] !== (credit ? 4 : 2)) throw new Error("unsupported envelope version");
    const localKey = privateKey(key);
    try {
        const aes = await derivedKey(
            localKey,
            publicKey(data.slice(1, 34)),
            data.slice(0, 62),
            viewingPublicKey(localKey),
            credit ? CREDIT_DOMAIN : NOTE_DOMAIN,
            true
        );
        return new Uint8Array(await crypto.subtle.exportKey("raw", aes));
    } finally {
        localKey.fill(0);
    }
}

function envelopeBytes(value: NoteBytes, credit: boolean): Uint8Array {
    const length = typeof value === "string" ? (value.length - 2) / 2 : value.length;
    const minimum = credit ? 402 : 160;
    if (length < minimum || length > minimum + 256) throw new Error("invalid envelope length");
    return bytes(value, length);
}
function readMemo(plain: Uint8Array, offset: number): { memo?: Uint8Array } {
    if (plain.length < offset + 2) throw new Error("missing memo length");
    const length = Number(decode(plain.slice(offset, offset + 2)));
    if (length > 256 || plain.length !== offset + 2 + length)
        throw new Error("invalid memo length");
    return length === 0 ? {} : { memo: plain.slice(offset + 2) };
}
