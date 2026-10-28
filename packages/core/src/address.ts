import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { getAddress } from "ethers";
import { validateClueKey } from "./fmd";

export interface ReceivingAddress {
    walletIdentity: `0x${string}`;
    viewingPublicKey: Uint8Array;
    clueKey: Uint8Array;
}
export type DecodedAddress =
    ({ kind: "long" } & ReceivingAddress) | { kind: "short"; walletIdentity: `0x${string}` };
export type ReceivingKeyLookup = (
    walletIdentity: `0x${string}`
) => Promise<Pick<ReceivingAddress, "viewingPublicKey" | "clueKey"> | null | undefined>;
const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
type Identity = bigint | `0x${string}`;

function identityBytes(value: Identity): Uint8Array {
    if (
        typeof value !== "bigint" &&
        (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    )
        throw new Error("invalid wallet identity encoding");
    const n = BigInt(value);
    if (n <= 0n || n >= 1n << 160n)
        throw new RangeError("wallet identity must be a nonzero EVM owner address");
    return hexToBytes(n.toString(16).padStart(40, "0"));
}
function receivingKeys(keys: Pick<ReceivingAddress, "viewingPublicKey" | "clueKey">) {
    const publicKey = keys.viewingPublicKey;
    if (
        !(publicKey instanceof Uint8Array) ||
        publicKey.length !== 33 ||
        (publicKey[0] !== 2 && publicKey[0] !== 3)
    )
        throw new Error("invalid compressed viewing public key");
    secp256k1.ProjectivePoint.fromHex(publicKey).assertValidity();
    validateClueKey(keys.clueKey);
    return { viewingPublicKey: Uint8Array.from(publicKey), clueKey: Uint8Array.from(keys.clueKey) };
}
function checkedText(prefix: string, data: string): string {
    const digest = keccak_256(utf8ToBytes("Invisi.AddressCaseChecksum.v1:" + prefix + data));
    return (
        prefix +
        Array.from(data, (character, i) =>
            (digest[i >> 3]! >> (7 - (i & 7))) & 1 ? character.toUpperCase() : character
        ).join("")
    );
}
function encode(prefix: string, payload: Uint8Array): string {
    let buffer = 0,
        bits = 0,
        data = "";
    for (const byte of payload) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            data += ALPHABET[(buffer >>> bits) & 31];
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits) data += ALPHABET[(buffer << (5 - bits)) & 31];
    return checkedText(prefix, data);
}

/** 138 characters: 0i plus the complete offline receiving materials. */
export function encodeLongAddress(recipient: ReceivingAddress): string {
    const identity = identityBytes(recipient.walletIdentity),
        keys = receivingKeys(recipient);
    return encode("0i", concatBytes(identity, keys.viewingPublicKey, keys.clueKey));
}
/** The owner's 42-character checksummed EVM address; receiving keys require a chosen registry. */
export function encodeShortAddress(walletIdentity: Identity): string {
    const identity = identityBytes(walletIdentity);
    return getAddress(
        typeof walletIdentity === "string" ? walletIdentity : `0x${bytesToHex(identity)}`
    );
}

/** Standard EVM short addresses or a full 0i address with a strict custom Base32 case checksum. */
export function decodeAddress(address: string): DecodedAddress {
    if (typeof address !== "string") throw new TypeError("address must be text");
    if (address.startsWith("0x")) {
        const owner = getAddress(address) as `0x${string}`;
        return { kind: "short", walletIdentity: `0x${bytesToHex(identityBytes(owner))}` };
    }
    if (!address.startsWith("0i")) throw new Error("invalid Invisi address prefix");
    const prefix = "0i";
    if (address.length !== 138) throw new Error("invalid address length");
    const data = address.slice(prefix.length).toLowerCase();
    if (Array.from(data).some((character) => !ALPHABET.includes(character)))
        throw new Error("invalid address alphabet");
    if (checkedText(prefix, data) !== address) throw new Error("invalid address case checksum");
    let buffer = 0,
        bits = 0;
    const payload: number[] = [];
    for (const character of data) {
        buffer = (buffer << 5) | ALPHABET.indexOf(character);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            payload.push((buffer >>> bits) & 255);
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits !== 0 || buffer !== 0) throw new Error("noncanonical address padding");
    const raw = Uint8Array.from(payload);
    const walletIdentity =
        `0x${bytesToHex(identityBytes(`0x${bytesToHex(raw.subarray(0, 20))}`))}` as const;
    return {
        kind: "long",
        walletIdentity,
        ...receivingKeys({ viewingPublicKey: raw.slice(20, 53), clueKey: raw.slice(53) }),
    };
}

/** Normalize either address into the same payment input. Long addresses never query. */
export async function resolveAddress(
    address: string,
    options: { lookup?: ReceivingKeyLookup } = {}
): Promise<ReceivingAddress> {
    const decoded = decodeAddress(address);
    if (decoded.kind === "long")
        return {
            walletIdentity: decoded.walletIdentity,
            viewingPublicKey: decoded.viewingPublicKey,
            clueKey: decoded.clueKey,
        };
    if (!options.lookup) throw new Error("short address requires an explicit registry lookup");
    const keys = await options.lookup(decoded.walletIdentity);
    if (!keys) throw new Error("wallet identity is not registered");
    return { walletIdentity: decoded.walletIdentity, ...receivingKeys(keys) };
}
