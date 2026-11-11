import { DeliveryAuthenticationError } from "./errors";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ascii, bytes, concat, encode } from "./binary";
import { deliveryCodec, validateDeliveryCiphertext } from "./delivery-codec";
import { NoteBytes, NoteDecryptionContext, NoteEncryptionContext } from "./types";
import { validateContext } from "./validation";

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

function privateKey(value: NoteBytes): Uint8Array {
    const key = bytes(value, 32);
    if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error("invalid viewing private key");
    return key;
}

export function publicKey(value: NoteBytes): Uint8Array {
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

export async function seal(
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

export async function open(
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
        const decrypted = await crypto.subtle
            .decrypt(
                {
                    name: "AES-GCM",
                    iv: buffer(data.slice(50, 62)),
                    additionalData: buffer(additionalData),
                    tagLength: 128,
                },
                aes,
                buffer(data.slice(62))
            )
            .catch((error: unknown) => {
                if (error instanceof Error && error.name === "OperationError")
                    throw new DeliveryAuthenticationError(error);
                throw error;
            });
        return new Uint8Array(decrypted);
    } finally {
        localKey.fill(0);
    }
}

function deliveryDomain(headerByte: number): Uint8Array {
    return ascii(deliveryCodec(headerByte).domain);
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

export function envelopeBytes(value: NoteBytes, credit: boolean): Uint8Array {
    return validateDeliveryCiphertext(value, credit ? "credit" : "funds");
}
