/**
 * Frozen S-FMD profile: decaf377-fmd 2.1.1, 24-bit clues (68 bytes).
 * Only FMD detection keys belong here; these are not transaction ownership keys.
 *
 * SECURITY: the noble Edwards arithmetic and this exact Decaf codec port use
 * JavaScript BigInt. They do not provide constant-time execution or reliable
 * secret erasure. This new composition has not received an independent audit.
 */
import { blake2b } from "@noble/hashes/blake2b";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
    FR,
    decodePoint,
    encodePoint,
    generator,
    inverseScalar,
    isIdentity,
    multiply,
    readLE,
    secureRandomBytes,
    writeLE,
} from "./decaf377.js";

const PRECISION = 24;
function requireBytes(value: Uint8Array, length: number, name: string): void {
    if (!(value instanceof Uint8Array) || value.length !== length)
        throw new TypeError(`${name} must be a ${length}-byte Uint8Array`);
}
function detectionScalar(key: Uint8Array): bigint {
    requireBytes(key, 32, "Detection key");
    const scalar = readLE(key);
    if (scalar === 0n || scalar >= FR)
        throw new Error("Detection key must be a canonical nonzero Decaf377 scalar");
    return scalar;
}
function hash(domain: string, ...parts: Uint8Array[]): Uint8Array {
    // Rust blake2b_simd defaults to 64 output bytes and zero-pads personalization.
    const personalization = new Uint8Array(16);
    personalization.set(utf8ToBytes(`decaf377-fmd.${domain}`));
    return blake2b(concatBytes(...parts), { dkLen: 64, personalization });
}
const hashScalar = (domain: string, ...parts: Uint8Array[]) => readLE(hash(domain, ...parts)) % FR;
const childOffset = (clueKey: Uint8Array, index: number) =>
    hashScalar("hkd", clueKey, Uint8Array.of(index));
const hashBit = (p: Uint8Array, shared: Uint8Array, q: Uint8Array) =>
    hash("bit", p, shared, q)[0]! & 1;

/** Derive the canonical 32-byte Decaf377 clue key from a nonzero FMD scalar. */
export function deriveClueKey(detectionKey: Uint8Array): Uint8Array {
    return encodePoint(multiply(generator, detectionScalar(detectionKey)));
}
/** Reject malformed, noncanonical, or identity clue keys. */
export function validateClueKey(clueKey: Uint8Array): void {
    requireBytes(clueKey, 32, "Clue key");
    if (isIdentity(decodePoint(clueKey))) throw new Error("Clue key must not be the identity");
}
/** Create a fixed 24-bit clue using a fresh WebCrypto random seed. */
export function createClue(clueKey: Uint8Array): Uint8Array {
    validateClueKey(clueKey);
    return createClueFromSeed(clueKey, secureRandomBytes(32));
}
/**
 * Deterministic interoperability/backend entry point. Seed must be independently
 * generated with a CSPRNG for every production clue; never reuse a fixed seed.
 */
export function createClueFromSeed(clueKey: Uint8Array, seed32: Uint8Array): Uint8Array {
    validateClueKey(clueKey);
    requireBytes(seed32, 32, "Clue seed");
    const root = decodePoint(clueKey);
    const r = hashScalar("rdv", clueKey, seed32);
    const z = hashScalar("zdv", clueKey, seed32);
    if (r === 0n) throw new Error("Degenerate clue seed");
    const p = encodePoint(multiply(generator, r));
    const q = encodePoint(multiply(generator, z));
    const ciphertext = new Uint8Array(3);
    for (let i = 0; i < PRECISION; i++) {
        const child = root.add(multiply(generator, childOffset(clueKey, i)));
        const shared = encodePoint(multiply(child, r));
        ciphertext[i >> 3] = ciphertext[i >> 3]! | ((hashBit(p, shared, q) ^ 1) << (i & 7));
    }
    const m = hashScalar("sca", p, Uint8Array.of(PRECISION), ciphertext);
    const y = ((z - m + FR) * inverseScalar(r)) % FR;
    if (y === 0n) throw new Error("Degenerate clue seed");
    return concatBytes(p, writeLE(y), Uint8Array.of(PRECISION), ciphertext);
}

/** Check a full-precision clue locally without exporting the detection key. */
export function detectClue(detectionKey: Uint8Array, clue: Uint8Array): boolean {
    const scalar = detectionScalar(detectionKey);
    requireBytes(clue, 68, "Clue");
    if (clue[64] !== PRECISION) return false;
    const p = clue.slice(0, 32),
        y = readLE(clue.slice(32, 64));
    if (y === 0n || y >= FR) return false;
    let point;
    try {
        point = decodePoint(p);
    } catch {
        return false;
    }
    if (isIdentity(point)) return false;
    const ciphertext = clue.slice(65);
    const m = hashScalar("sca", p, Uint8Array.of(PRECISION), ciphertext);
    const q = encodePoint(multiply(generator, m).add(multiply(point, y)));
    const clueKey = deriveClueKey(detectionKey);
    for (let i = 0; i < PRECISION; i++) {
        const child = (scalar + childOffset(clueKey, i)) % FR;
        const bit = hashBit(p, encodePoint(multiply(point, child)), q);
        if ((bit ^ ((ciphertext[i >> 3]! >> (i & 7)) & 1)) !== 1) return false;
    }
    return true;
}
