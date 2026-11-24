import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { decodeAddress } from "../address/address";
import { FR, readLE } from "../fmd/decaf377";

type OwnerAddress = `0x${string}`;

function normalizeOwnerAddress(address: string): OwnerAddress {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error("expected a nonzero EVM owner address");
    }
    return decodeAddress(address).ownerAddress;
}

export function ownerAddressFromUncompressedPublicKey(publicKey: Uint8Array): OwnerAddress {
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

/** The exact v1 message bytes for EIP-191 personal signing. */
export function buildReceivingKeyMessage(ownerAddress: string): Uint8Array {
    return utf8ToBytes(
        `Invisi Privacy Receiving Keys v1\nAccount: ${normalizeOwnerAddress(ownerAddress)}\nPurpose: derive viewing and detection keys only.`
    );
}

export function receivingKeyDigest(ownerAddress: string): Uint8Array {
    const message = buildReceivingKeyMessage(ownerAddress);
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`);
    return keccak_256(concatBytes(prefix, message));
}

export function signReceivingKeyMessage(ownerAddress: OwnerAddress, privateKey: Uint8Array) {
    const signed = secp256k1.sign(receivingKeyDigest(ownerAddress), privateKey, {
        lowS: true,
        prehash: false,
        extraEntropy: false,
    });
    if (signed.recovery !== 0 && signed.recovery !== 1) {
        throw new Error("unsupported receiving signature recovery bit");
    }
    const compact = signed.toCompactRawBytes();
    try {
        return concatBytes(compact, Uint8Array.of(signed.recovery));
    } finally {
        compact.fill(0);
    }
}

export function normalizeReceivingSignature(
    ownerAddress: OwnerAddress,
    digest: Uint8Array,
    signature: string | Uint8Array
): Uint8Array {
    if (
        typeof signature !== "string"
            ? !(signature instanceof Uint8Array) ||
              (signature.length !== 64 && signature.length !== 65)
            : !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)
    ) {
        throw new Error("invalid receiving signature encoding");
    }
    const raw =
        typeof signature === "string" ? hexToBytes(signature.slice(2)) : Uint8Array.from(signature);
    try {
        let recovery: number;
        if (raw.length === 64) {
            recovery = raw[32]! >>> 7;
            raw[32] = raw[32]! & 0x7f;
        } else {
            const v = raw[64]!;
            recovery = v >= 27 ? v - 27 : v;
            if (recovery !== 0 && recovery !== 1)
                throw new Error("invalid receiving signature recovery bit");
        }

        // Normalization preserves verification only when the recovery parity flips with s.
        let canonical;
        let publicKey;
        try {
            const parsed = secp256k1.Signature.fromCompact(raw.subarray(0, 64));
            canonical = parsed.normalizeS().addRecoveryBit(recovery ^ Number(parsed.hasHighS()));
            publicKey = canonical.recoverPublicKey(digest).toRawBytes(false);
            if (!secp256k1.verify(canonical, digest, publicKey, { lowS: true, prehash: false })) {
                throw new Error("signature verification failed");
            }
        } catch {
            throw new Error("invalid receiving signature");
        }
        if (ownerAddressFromUncompressedPublicKey(publicKey) !== ownerAddress) {
            throw new Error("receiving signature owner mismatch");
        }
        return canonical.toCompactRawBytes();
    } finally {
        raw.fill(0);
    }
}

export function deriveReceivingRoot(ownerAddress: OwnerAddress, material: Uint8Array): Uint8Array {
    return hkdf(
        sha256,
        material,
        utf8ToBytes("Invisi.ReceivingRoot.v1"),
        hexToBytes(ownerAddress.slice(2)),
        32
    );
}

function deriveScalar(
    key: Uint8Array,
    salt: string,
    modulus: bigint,
    littleEndian = false
): Uint8Array {
    const saltBytes = utf8ToBytes(salt);
    for (let counter = 0; counter <= 0xffffffff; counter++) {
        const info = Uint8Array.of(counter >>> 24, counter >>> 16, counter >>> 8, counter);
        const result = hkdf(sha256, key, saltBytes, info, 32);
        if (littleEndian) result[31] = result[31]! & 7;
        const candidate = littleEndian ? readLE(result) : BigInt(`0x${bytesToHex(result)}`);
        if (candidate > 0n && candidate < modulus) return result;
        result.fill(0);
    }
    throw new Error("scalar derivation exhausted");
}

export function deriveReceivingSecrets(owner: string, signature: string | Uint8Array) {
    const ownerAddress = normalizeOwnerAddress(owner);
    const material = normalizeReceivingSignature(
        ownerAddress,
        receivingKeyDigest(ownerAddress),
        signature
    );
    let root: Uint8Array | undefined;
    let viewingPrivateKey: Uint8Array | undefined;
    let detectionSeed: Uint8Array | undefined;
    let complete = false;
    try {
        root = deriveReceivingRoot(ownerAddress, material);
        viewingPrivateKey = deriveScalar(root, "Invisi.WalletViewingKey.v1", secp256k1.CURVE.n);
        detectionSeed = hkdf(
            sha256,
            root,
            utf8ToBytes("Invisi.WalletDetectionSeed.v1"),
            new Uint8Array(),
            32
        );
        const detectionKey = deriveScalar(detectionSeed, "Invisi.WalletDetectionKey.v1", FR, true);
        complete = true;
        return { ownerAddress, viewingPrivateKey, detectionSeed, detectionKey };
    } finally {
        material.fill(0);
        root?.fill(0);
        if (!complete) {
            viewingPrivateKey?.fill(0);
            detectionSeed?.fill(0);
        }
    }
}
