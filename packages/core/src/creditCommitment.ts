import { poseidonHash } from "./poseidon";
import { FIELD_MODULUS } from "./random";
import type { CreditNote, CreditPolicy, CreditRemainderRecovery, ProtocolContext } from "./types";
import { assertNoteContext } from "./noteContext";
import {
    D_CREDIT,
    D_CNULL,
    D_CREDIT_KEY_HASH,
    D_CREDIT_RECOVERY,
    D_CREDIT_REMAINDER_NONCE,
} from "./domains";

export const CREDIT_POLICY_FIELDS = [
    "singleLimit",
    "dailyLimit",
    "monthlyLimit",
    "lastDay",
    "dailySpent",
    "lastMonth",
    "monthlySpent",
] as const;
export function normalizeCreditPolicy(value: Partial<CreditPolicy> = {}): CreditPolicy {
    const policy = Object.fromEntries(
        CREDIT_POLICY_FIELDS.map((key) => {
            const n = value[key] ?? 0n;
            if (typeof n !== "bigint") throw new TypeError(`${key} must be bigint`);
            uint(
                n,
                key === "lastDay" || key === "lastMonth"
                    ? 64
                    : key === "dailySpent" || key === "monthlySpent"
                      ? 128
                      : 126,
                key
            );
            return [key, n];
        })
    ) as unknown as CreditPolicy;
    for (const [period, spent] of [
        ["lastDay", "dailySpent"],
        ["lastMonth", "monthlySpent"],
    ] as const) {
        if (policy[period] === 0n && policy[spent] !== 0n)
            throw new Error("noncanonical Credit usage");
    }
    return policy;
}
/** UTC Gregorian periods from explicit uint64 chain seconds, without wall-clock defaults. */
export function creditPeriods(timestamp: bigint): { currentDay: bigint; currentMonth: bigint } {
    if (typeof timestamp !== "bigint") throw new TypeError("Credit timestamp required");
    uint(timestamp, 64, "timestamp");
    const days = timestamp / 86400n,
        z = days + 719468n,
        era = z / 146097n,
        doe = z - era * 146097n;
    const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
    let year = yoe + era * 400n;
    const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n),
        mp = (5n * doy + 2n) / 153n;
    const month = mp + (mp < 10n ? 3n : -9n);
    if (month <= 2n) year++;
    return { currentDay: days + 1n, currentMonth: (year - 1970n) * 12n + month };
}
/** Apply each input's policy before considering whether a remainder exists. */
export function applyCreditDrawUsage(
    note: Pick<CreditNote, "amount"> & Partial<CreditPolicy>,
    amount: bigint,
    timestamp: bigint
): CreditPolicy {
    const policy = normalizeCreditPolicy(note),
        periods = creditPeriods(timestamp);
    uint(amount, 126, "draw amount");
    if (amount === 0n || amount > note.amount) throw new Error("draw amount outside balance");
    if (policy.singleLimit !== 0n && amount > policy.singleLimit)
        throw new Error("single limit exceeded");
    for (const [limit, last, spent, current] of [
        ["dailyLimit", "lastDay", "dailySpent", "currentDay"],
        ["monthlyLimit", "lastMonth", "monthlySpent", "currentMonth"],
    ] as const) {
        const period = periods[current];
        if (period < policy[last]) throw new Error("Credit period rollback");
        policy[spent] = (period === policy[last] ? policy[spent] : 0n) + amount;
        uint(policy[spent], 128, spent);
        policy[last] = period;
        if (policy[limit] !== 0n && policy[spent] > policy[limit])
            throw new Error(`${limit} exceeded`);
    }
    return policy;
}

export async function computeCreditSharedKeyHash(creditSharedKey: bigint): Promise<`0x${string}`> {
    if (creditSharedKey <= 0n || creditSharedKey >= FIELD_MODULUS)
        throw new RangeError("invalid Credit shared key");
    return poseidonHash([D_CREDIT_KEY_HASH, creditSharedKey]);
}

export async function computeCreditCommitment(
    chainId: bigint,
    spenderWalletIdentity: `0x${string}`,
    ownerWalletIdentity: `0x${string}`,
    spenderPayout: bigint,
    ownerPayout: bigint,
    tokenAddress: bigint,
    amount: bigint,
    nonce: bigint,
    expiry: bigint,
    creditSharedKeyHash: `0x${string}`,
    policy: Partial<CreditPolicy> = {}
): Promise<`0x${string}`> {
    uint(chainId, 64, "chainId");
    uint(tokenAddress, 160, "tokenAddress");
    uint(spenderPayout, 160, "spenderPayout");
    uint(ownerPayout, 160, "ownerPayout");
    uint(amount, 126, "amount");
    uint(expiry, 64, "expiry");
    for (const identity of [spenderWalletIdentity, ownerWalletIdentity]) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(identity)) throw new Error("invalid Credit field encoding");
        field(BigInt(identity), "Credit field");
    }
    if (
        BigInt(spenderWalletIdentity) === 0n ||
        BigInt(ownerWalletIdentity) === 0n ||
        spenderPayout === 0n ||
        ownerPayout === 0n ||
        amount === 0n ||
        expiry === 0n
    )
        throw new Error("Credit identities, payouts, amount and expiry must be positive");
    if (
        BigInt(spenderWalletIdentity) !== spenderPayout ||
        BigInt(ownerWalletIdentity) !== ownerPayout
    )
        throw new Error("Credit payout must equal its owner identity");
    if (!/^0x[0-9a-fA-F]{64}$/.test(creditSharedKeyHash))
        throw new Error("invalid Credit shared key hash");
    field(BigInt(creditSharedKeyHash), "Credit shared key hash");
    return poseidonHash([
        D_CREDIT,
        chainId,
        BigInt(spenderWalletIdentity),
        BigInt(ownerWalletIdentity),
        spenderPayout,
        ownerPayout,
        tokenAddress,
        amount,
        nonce,
        expiry,
        BigInt(creditSharedKeyHash),
        ...CREDIT_POLICY_FIELDS.map((key) => normalizeCreditPolicy(policy)[key]),
    ]);
}

export async function computeCreditNullifier(
    chainId: bigint,
    creditSharedKey: bigint,
    creditCommitment: `0x${string}`
): Promise<`0x${string}`> {
    uint(chainId, 64, "chainId");
    if (creditSharedKey <= 0n || creditSharedKey >= FIELD_MODULUS)
        throw new RangeError("invalid Credit shared key");
    if (!/^0x[0-9a-fA-F]{64}$/.test(creditCommitment))
        throw new Error("invalid Credit commitment encoding");
    return poseidonHash([D_CNULL, chainId, creditSharedKey, BigInt(creditCommitment)]);
}

/** Tag10: deterministic remainder nonce, scoped to the deployment and spend. */
export async function deriveRemainderNonce(
    chainId: bigint,
    protocolAddress: bigint,
    tokenAddress: bigint,
    creditNullifier: bigint,
    creditSharedKey: bigint
): Promise<bigint> {
    return BigInt(
        await poseidonHash([
            D_CREDIT_REMAINDER_NONCE,
            chainId,
            protocolAddress,
            tokenAddress,
            creditNullifier,
            creditSharedKey,
        ])
    );
}

/** Tag9: additive recovery pad; recoveryAmount = (remainingAmount + pad) mod p. */
export async function computeCreditRecoveryPad(
    chainId: bigint,
    protocolAddress: bigint,
    tokenAddress: bigint,
    creditNullifier: bigint,
    creditSharedKey: bigint
): Promise<bigint> {
    return BigInt(
        await poseidonHash([
            D_CREDIT_RECOVERY,
            chainId,
            protocolAddress,
            tokenAddress,
            creditNullifier,
            creditSharedKey,
        ])
    );
}

function uint(value: bigint, bits: number, name: string): void {
    if (value < 0n || value >= 1n << BigInt(bits))
        throw new RangeError(`${name} out of uint${bits} range`);
}

function field(value: bigint, name: string): void {
    if (value < 0n || value >= FIELD_MODULUS)
        throw new RangeError(`${name} out of BN254 field range`);
}

/**
 * Recover a remainder from a previously authenticated note and authenticated draw
 * event fields. Checks the consumed nullifier, amount range and output commitment.
 * The shared Credit key, identities and expiry remain unchanged. A full draw
 * returns null only when both remainder commitment and recovery amount are zero.
 */
export async function recoverCreditRemainder(
    context: ProtocolContext,
    previousNote: CreditNote,
    recovery: CreditRemainderRecovery
): Promise<CreditNote | null> {
    const scopedContext = { ...context };
    const { memo: _unknownMemo, ...scopedNote } = previousNote;
    const scopedRecovery = { ...recovery };
    uint(scopedContext.chainId, 64, "chainId");
    uint(scopedContext.protocolAddress, 160, "protocolAddress");
    assertNoteContext(scopedNote, scopedContext);
    uint(scopedNote.tokenAddress, 160, "tokenAddress");
    uint(scopedNote.amount, 126, "amount");
    uint(scopedNote.expiry, 64, "expiry");
    field(scopedNote.nonce, "nonce");
    field(BigInt(scopedNote.spenderWalletIdentity), "spenderWalletIdentity");
    field(BigInt(scopedNote.ownerWalletIdentity), "ownerWalletIdentity");
    field(scopedNote.creditSharedKey, "creditSharedKey");
    if (scopedNote.amount === 0n || scopedNote.creditSharedKey === 0n)
        throw new Error("amount and creditSharedKey must be nonzero");
    const nullifier = BigInt(scopedRecovery.creditNullifier);
    const commitment = BigInt(scopedRecovery.remainderCommitment);
    field(nullifier, "creditNullifier");
    field(commitment, "remainderCommitment");
    field(scopedRecovery.recoveryAmount, "recoveryAmount");
    const previousCommitment = await computeCreditCommitment(
        scopedContext.chainId,
        scopedNote.spenderWalletIdentity,
        scopedNote.ownerWalletIdentity,
        scopedNote.spenderPayout,
        scopedNote.ownerPayout,
        scopedNote.tokenAddress,
        scopedNote.amount,
        scopedNote.nonce,
        scopedNote.expiry,
        await computeCreditSharedKeyHash(scopedNote.creditSharedKey),
        scopedNote
    );
    const expectedNullifier = await computeCreditNullifier(
        scopedContext.chainId,
        scopedNote.creditSharedKey,
        previousCommitment
    );
    if (nullifier === 0n || BigInt(expectedNullifier) !== nullifier)
        throw new Error("previous credit nullifier mismatch");
    if (commitment === 0n) {
        if (scopedRecovery.recoveryAmount !== 0n)
            throw new Error("full draw requires zero recovery amount");
        applyCreditDrawUsage(scopedNote, scopedNote.amount, scopedRecovery.timestamp);
        return null;
    }
    const args = [
        scopedContext.chainId,
        scopedContext.protocolAddress,
        scopedNote.tokenAddress,
        nullifier,
        scopedNote.creditSharedKey,
    ] as const;
    const nonce = await deriveRemainderNonce(...args);
    const pad = await computeCreditRecoveryPad(...args);
    const amount = (scopedRecovery.recoveryAmount - pad + FIELD_MODULUS) % FIELD_MODULUS;
    if (amount === 0n || amount >= scopedNote.amount || amount >= 1n << 126n)
        throw new Error("invalid recovered remainder amount");
    if (nonce === scopedNote.nonce) throw new Error("remainder nonce must change");
    const usage = applyCreditDrawUsage(
        scopedNote,
        scopedNote.amount - amount,
        scopedRecovery.timestamp
    );
    const expectedCommitment = await computeCreditCommitment(
        scopedContext.chainId,
        scopedNote.spenderWalletIdentity,
        scopedNote.ownerWalletIdentity,
        scopedNote.spenderPayout,
        scopedNote.ownerPayout,
        scopedNote.tokenAddress,
        amount,
        nonce,
        scopedNote.expiry,
        await computeCreditSharedKeyHash(scopedNote.creditSharedKey),
        usage
    );
    if (BigInt(expectedCommitment) !== commitment)
        throw new Error("recovered credit commitment mismatch");
    return { ...scopedNote, ...usage, amount, nonce };
}
