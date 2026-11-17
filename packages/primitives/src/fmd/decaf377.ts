/**
 * Internal Decaf377 codec, ported from decaf377 0.10.1 min_curve/element.rs.
 * Edwards group/field arithmetic is supplied by @noble/curves 1.9.1. The
 * Montgomery constants below are converted to ordinary field integers.
 * This JavaScript BigInt backend is NOT constant-time and has not been audited.
 */
import { twistedEdwards, type ExtPointType } from "@noble/curves/abstract/edwards";
import { Field, mod } from "@noble/curves/abstract/modular";
import { blake2b } from "@noble/hashes/blake2b";

export const FQ = 8444461749428370424248824938781546531375899335154063827935233455917409239041n;
export const FR = 2111115437357092606062206234695386632838870926408408195193685246394721360383n;
const field = Field(FQ, 253, true);
const f = (n: bigint) => mod(n, FQ);
const abs = (n: bigint) => ((n & 1n) === 0n ? n : f(-n));

export function secureRandomBytes(length: number): Uint8Array {
    const webCrypto = (
        globalThis as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } }
    ).crypto;
    if (!webCrypto?.getRandomValues) throw new Error("WebCrypto secure randomness is unavailable");
    return webCrypto.getRandomValues(new Uint8Array(length));
}

const curve = twistedEdwards({
    a: FQ - 1n,
    d: 3021n,
    Fp: field,
    n: FR,
    h: 4n,
    Gx: 4959445789346820725352484487855828915252512307947624787834978378872129235627n,
    Gy: 6060471950081851567114691557659790004756535011754163002297540472747064943288n,
    hash: blake2b,
    randomBytes: (length = 32) => secureRandomBytes(length),
});
export type DecafPoint = ExtPointType;
export const generator: DecafPoint = curve.ExtendedPoint.BASE;

export function readLE(bytes: Uint8Array): bigint {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
    return n;
}
export function writeLE(n: bigint): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = Number(n & 255n);
        n >>= 8n;
    }
    return bytes;
}
export function multiply(point: DecafPoint, scalar: bigint): DecafPoint {
    return scalar === 0n ? curve.ExtendedPoint.ZERO : point.multiply(scalar);
}
export function inverseScalar(scalar: bigint): bigint {
    // Noble's field inversion uses Euclid. Neither this nor BigInt is constant-time.
    return Field(FR).inv(scalar);
}

const sqrtOddOrder = (FQ - 1n) >> 47n;
const sqrtRootOfUnity = field.pow(11n, sqrtOddOrder);

export function inverseSquareRoot(denominator: bigint): bigint {
    if (denominator <= 0n || denominator >= FQ)
        throw new Error("Invalid Decaf377 square root input");
    let root = field.pow(denominator, (sqrtOddOrder - 1n) >> 1n);
    let residue = f(root * root * denominator);
    let unity = sqrtRootOfUnity;
    let order = 47;
    while (residue !== 1n) {
        let index = 0;
        let power = residue;
        while (power !== 1n && index < order) {
            power = f(power * power);
            index++;
        }
        if (index >= order) throw new Error("Invalid Decaf377 square root");
        let adjustment = unity;
        for (let i = 0; i < order - index - 1; i++) adjustment = f(adjustment * adjustment);
        root = f(root * adjustment);
        unity = f(adjustment * adjustment);
        residue = f(residue * unity);
        order = index;
    }
    if (f(root * root * denominator) !== 1n) throw new Error("Invalid Decaf377 square root");
    return root;
}

export function decodePoint(bytes: Uint8Array): DecafPoint {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
        throw new Error("Invalid Decaf377 encoding length");
    const s = readLE(bytes);
    if (s >= FQ || (s & 1n) !== 0n || bytes[31]! >> 5 !== 0)
        throw new Error("Invalid Decaf377 encoding");
    const ss = f(s * s);
    const u1 = f(1n - ss);
    const u2 = f(u1 * u1 - 4n * 3021n * ss);
    const denominator = f(u2 * u1 * u1);
    if (denominator === 0n) throw new Error("Invalid Decaf377 encoding");
    let v: bigint;
    try {
        v = inverseSquareRoot(denominator);
    } catch {
        throw new Error("Invalid Decaf377 encoding");
    }
    const twoSU1 = f(2n * s * u1);
    if ((f(twoSU1 * v) & 1n) !== 0n) v = f(-v);
    const x = f(twoSU1 * v * v * u2);
    const y = f((1n + ss) * v * u1);
    return curve.ExtendedPoint.fromAffine({ x, y });
}
export function encodePoint(point: DecafPoint): Uint8Array {
    const { ex: x, ez: z, et: t } = point;
    if (x === 0n) return new Uint8Array(32);
    const aMinusD = -3022n;
    const u1 = f((x + t) * (x - t));
    const denominator = f(u1 * aMinusD * x * x);
    const v = inverseSquareRoot(denominator);
    const u2 = abs(f(v * u1));
    const u3 = f(u2 * z - t);
    return writeLE(abs(f(aMinusD * v * u3 * x)));
}
export function isIdentity(point: DecafPoint): boolean {
    return point.ex === 0n;
}
