import type { Address, Delivery, FundingParams, Hex, InputSource } from "./contracts";
import {
    AbiCoder,
    dataLength,
    getAddress,
    isHexString,
    keccak256,
    ParamType,
    toBeHex,
} from "ethers";

export type { DeploymentContext } from "@invisi-labs/rpc";
import type { DeploymentContext } from "@invisi-labs/rpc";
export interface TransactionContext extends DeploymentContext {
    tokenAddress: Address;
    now?: bigint;
}
export const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_WORD = toBeHex(0n, 32) as Hex;
export const EMPTY_PERMIT = {
    deadline: 0n,
    v: 0,
    r: ZERO_WORD,
    s: ZERO_WORD,
} as const;
export const EMPTY_FUNDING: FundingParams = {
    payer: ZERO_ADDRESS,
    amount: 0n,
    sigNonce: 0n,
    deadline: 0n,
    signature: "0x",
    permit: EMPTY_PERMIT,
};
export type FundingInput = Partial<Omit<FundingParams, "permit">> & {
    permit?: FundingParams["permit"];
};
export function uint(v: bigint | number | string, bits: number, name = "value"): bigint {
    if (
        (typeof v !== "bigint" && typeof v !== "number" && typeof v !== "string") ||
        (typeof v === "number" && !Number.isSafeInteger(v))
    )
        throw new Error(`${name} must be an integer`);
    const n = BigInt(v);
    if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${name} exceeds u${bits}`);
    return n;
}
export function field(v: bigint | string, name = "field"): bigint {
    const n = uint(v, 256, name);
    if (n >= FIELD_MODULUS) throw new Error(`${name} is noncanonical field`);
    return n;
}
export const word = (v: bigint | string): Hex =>
    toBeHex(typeof v === "bigint" ? v : BigInt(v), 32) as Hex;
export function dense<T>(v: readonly T[], name: string): readonly T[] {
    if (!Array.isArray(v)) throw new Error(`${name} must be array`);
    for (let i = 0; i < v.length; i++)
        if (!Object.hasOwn(v, i) || v[i] === undefined || v[i] === null)
            throw new Error(`${name} has missing or sparse entries`);
    return v;
}
export function known(v: object, keys: readonly string[], name = "params") {
    if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).some((k) => !keys.includes(k))
    )
        throw new Error(`${name} has unsupported fields`);
}
export function notes(v: readonly Hex[], name: string) {
    const r = dense(v, name).map((v) => word(field(v, name)));
    if (r.some((v) => BigInt(v) === 0n) || new Set(r).size !== r.length)
        throw new Error(`duplicate or zero ${name}`);
    return r;
}
export function envelope(v: Hex, length: number, version?: number): Hex {
    if (!isHexString(v) || !/^0x(?:[a-fA-F0-9]{2})*$/.test(v) || dataLength(v) !== length)
        throw new Error(`ciphertext must be ${length} bytes`);
    if (version !== undefined && Number.parseInt(v.slice(2, 4), 16) !== version)
        throw new Error("unsupported ciphertext envelope version");
    return v;
}
export function normalizeContext(c: TransactionContext) {
    return {
        ...c,
        chainId: uint(c.chainId, 64, "chainId"),
        protocolAddress: getAddress(c.protocolAddress) as Hex,
        tokenAddress: getAddress(c.tokenAddress) as Hex,
    };
}
export function checkDeadline(c: TransactionContext, value: bigint) {
    const n = uint(value, 64, "deadline");
    if (c.now !== undefined && n < uint(c.now, 64, "now")) throw new Error("deadline has expired");
    return n;
}
export function normalizeSources(
    sources: readonly InputSource[],
    inputCount: number,
    capacity: number
) {
    dense(sources, "sources");
    if (
        inputCount < 0 ||
        inputCount > capacity ||
        sources.length > inputCount ||
        (inputCount === 0 ? sources.length !== 0 : sources.length === 0)
    )
        throw new Error("source count must be 1..inputCount, or empty for zero inputs");
    let previous = 0n;
    return sources.map((s) => {
        known(s, ["treeId", "merkleRoot"], "source");
        const treeId = uint(s.treeId, 64, "treeId"),
            merkleRoot = word(field(s.merkleRoot, "merkleRoot"));
        if (treeId === 0n || treeId <= previous || BigInt(merkleRoot) === 0n)
            throw new Error("sources must have positive roots and strictly ascending tree IDs");
        previous = treeId;
        return { treeId, merkleRoot };
    });
}
export const pad = (v: readonly bigint[], n: number): bigint[] => [
    ...v,
    ...(Array(n - v.length).fill(0n) as bigint[]),
];
export function normalizeDelivery(
    value: Delivery,
    options: { credit?: boolean; empty?: boolean } = {}
): Delivery {
    known(value, ["ciphertext", "clue"], "delivery");
    if (options.empty) {
        if (value.ciphertext !== "0x" || value.clue !== "0x")
            throw new Error("absent output requires an empty delivery");
        return { ciphertext: "0x", clue: "0x" };
    }
    const ciphertext = envelope(
        value.ciphertext,
        options.credit ? 400 : 158,
        options.credit ? 3 : 1
    );
    const clue = envelope(value.clue, 68);
    if (clue.slice(130, 132).toLowerCase() !== "18") throw new Error("clue precision must be 24");
    return { ciphertext, clue };
}
export const deliveriesHash = (v: readonly Delivery[]) =>
    keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [
                {
                    type: "tuple[]",
                    components: [
                        { name: "ciphertext", type: "bytes" },
                        { name: "clue", type: "bytes" },
                    ],
                },
            ].map((parameter) => ParamType.from(parameter)),
            [dense(v, "deliveries")]
        ) as Hex
    ) as Hex;
export function normalizeFunding(input: FundingInput = {}): FundingParams {
    const f = { ...EMPTY_FUNDING, ...input };
    getAddress(f.payer) as Hex;
    uint(f.amount, 128, "depositAmount");
    uint(f.sigNonce, 256, "sigNonce");
    uint(f.deadline, 256, "funding deadline");
    if (!isHexString(f.signature) || !/^0x(?:[a-fA-F0-9]{2})*$/.test(f.signature))
        throw new Error("invalid signature bytes");
    const p = f.permit;
    uint(p.deadline, 256);
    uint(p.v, 8);
    for (const v of [p.r, p.s])
        if (!isHexString(v) || dataLength(v) !== 32) throw new Error("permit r/s must be bytes32");
    if ((f.amount === 0n) !== (BigInt(f.payer) === 0n))
        throw new Error("deposit amount and payer must both be zero or positive");
    if (
        f.amount === 0n &&
        (f.sigNonce !== 0n ||
            f.deadline !== 0n ||
            f.signature !== "0x" ||
            p.deadline !== 0n ||
            p.v !== 0 ||
            BigInt(p.r) !== 0n ||
            BigInt(p.s) !== 0n)
    )
        throw new Error("zero funding must be entirely empty");
    return { ...f, payer: getAddress(f.payer) as Hex };
}
export function validateFundingSubmission(f: FundingParams, caller?: Address, now?: bigint) {
    if (f.signature !== "0x" && now !== undefined && uint(now, 64, "now") > f.deadline)
        throw new Error("funding authorization has expired");
    if (
        f.signature === "0x" &&
        (f.sigNonce !== 0n ||
            f.deadline !== 0n ||
            (caller !== undefined && f.amount > 0n && (getAddress(caller) as Hex) !== f.payer))
    )
        throw new Error("direct funding requires payer caller and zero nonce/deadline");
}
export const getEIP712Domain = (c: TransactionContext) => ({
    name: "InvisibleProtocol",
    version: "1",
    chainId: uint(c.chainId, 64),
    verifyingContract: getAddress(c.protocolAddress) as Hex,
});
export const fundingFields = [
    { name: "requestHash", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "sigNonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
] as const;
