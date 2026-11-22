declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
import {
    D_CNULL,
    D_CREDIT,
    D_CREDIT_KEY_HASH,
    D_CREDIT_RECOVERY,
    D_CREDIT_STATE_NONCE,
} from "../crypto/domains";
import { poseidonHash } from "../crypto/poseidon";
import { FIELD_MODULUS } from "../crypto/random";
import type {
    CreditState,
    CreditPolicy,
    CreditUsage,
    CreditStateRecovery,
    ProtocolContext,
} from "../types";
import { assertNoteContext } from "../notes/noteContext";

/** A grant identifier is a positive uint128; decimal text must be canonical and lossless. */
export function normalizeCreditGrantId(value: unknown): bigint {
    if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) value = BigInt(value);
    if (typeof value !== "bigint" || value <= 0n || value >= 1n << 128n)
        throw new RangeError("grantId must be a canonical positive uint128");
    return value;
}

/** Generate independently before proving, with browser/Node Web Crypto. */
export function generateCreditGrantId(value?: unknown): bigint {
    if (value !== undefined) return normalizeCreditGrantId(value);
    const bytes = new Uint8Array(16);
    for (;;) {
        crypto.getRandomValues(bytes);
        const candidate = bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);
        if (candidate !== 0n) return candidate;
    }
}

export const CREDIT_POLICY_FIELDS = ["singleLimit", "dailyLimit", "monthlyLimit"] as const;
export const CREDIT_USAGE_FIELDS = [
    "lastDay",
    "dailySpent",
    "lastMonth",
    "monthlySpent",
    "totalSpent",
] as const;
export function normalizeCreditPolicy(value: Partial<CreditPolicy> = {}): CreditPolicy {
    return Object.fromEntries(
        CREDIT_POLICY_FIELDS.map((key) => {
            const n = value[key] ?? 0n;
            uint(n, 126, key);
            return [key, n];
        })
    ) as unknown as CreditPolicy;
}
export function normalizeCreditUsage(value: Partial<CreditUsage> = {}): CreditUsage {
    const usage = Object.fromEntries(
        CREDIT_USAGE_FIELDS.map((key) => {
            const n = value[key] ?? 0n;
            uint(n, key === "lastDay" || key === "lastMonth" ? 64 : 128, key);
            return [key, n];
        })
    ) as unknown as CreditUsage;
    for (const [period, spent] of [
        ["lastDay", "dailySpent"],
        ["lastMonth", "monthlySpent"],
    ] as const)
        if (usage[period] === 0n && usage[spent] !== 0n) throw Error("noncanonical Credit usage");
    return usage;
}
function balance(value: Pick<CreditState, "availableCredit" | "unlimited">) {
    uint(value.availableCredit, 128, "availableCredit");
    if (typeof value.unlimited !== "boolean") throw TypeError("unlimited must be boolean");
    if (value.unlimited && value.availableCredit !== 0n)
        throw Error("unlimited Credit must have zero available credit");
    return { availableCredit: value.availableCredit, unlimited: value.unlimited };
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
/** Accumulate actual debits even when limits are disabled. */
export function applyCreditDrawUsage(
    note: Partial<CreditPolicy & CreditUsage> & Pick<CreditState, "availableCredit" | "unlimited">,
    amount: bigint,
    timestamp: bigint
): CreditPolicy & CreditUsage & Pick<CreditState, "availableCredit" | "unlimited"> {
    const policy = {
            ...normalizeCreditPolicy(note),
            ...normalizeCreditUsage(note),
            ...balance(note),
        },
        periods = creditPeriods(timestamp);
    uint(amount, 126, "draw amount");
    if (amount === 0n) throw new Error("draw amount must be positive");
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
    policy.totalSpent += amount;
    uint(policy.totalSpent, 128, "totalSpent");
    if (!policy.unlimited) {
        if (amount > policy.availableCredit) throw Error("available credit exceeded");
        policy.availableCredit -= amount;
    }
    return policy;
}

export async function computeCreditSharedKeyHash(creditSharedKey: bigint): Promise<`0x${string}`> {
    if (creditSharedKey <= 0n || creditSharedKey >= FIELD_MODULUS)
        throw new RangeError("invalid Credit shared key");
    return poseidonHash([D_CREDIT_KEY_HASH, creditSharedKey]);
}

export function normalizeCreditState(state: CreditState): CreditState {
    const allowed = [
        "chainId",
        "protocolAddress",
        "tokenAddress",
        "spenderWalletIdentity",
        "ownerWalletIdentity",
        "grantId",
        "nonce",
        "expiry",
        "creditSharedKey",
        ...CREDIT_POLICY_FIELDS,
        ...CREDIT_USAGE_FIELDS,
        "availableCredit",
        "unlimited",
        "payload",
    ];
    if (!state || typeof state !== "object" || Object.keys(state).some((k) => !allowed.includes(k)))
        throw Error("Unsupported Credit fields");
    for (const [name, bits] of [
        ["chainId", 64],
        ["protocolAddress", 160],
        ["tokenAddress", 160],
        ["grantId", 128],
        ["expiry", 64],
    ] as const)
        uint(state[name], bits, name);
    normalizeCreditGrantId(state.grantId);
    for (const id of [state.spenderWalletIdentity, state.ownerWalletIdentity])
        if (!/^0x[0-9a-fA-F]{40}$/.test(id) || BigInt(id) === 0n)
            throw Error("invalid Credit identity");
    if (!state.protocolAddress || !state.tokenAddress || !state.grantId || !state.expiry)
        throw Error("Credit deployment, token, grantId and expiry must be positive");
    field(state.nonce, "nonce");
    field(state.creditSharedKey, "creditSharedKey");
    if (!state.creditSharedKey) throw Error("Credit shared key must be positive");
    if (state.payload !== undefined && !(state.payload instanceof Uint8Array))
        throw TypeError("payload must be Uint8Array");
    return {
        ...state,
        // Compare and group EVM identities by their address value, independent of hex casing.
        ownerWalletIdentity: state.ownerWalletIdentity.toLowerCase() as `0x${string}`,
        spenderWalletIdentity: state.spenderWalletIdentity.toLowerCase() as `0x${string}`,
        ...normalizeCreditPolicy(state),
        ...normalizeCreditUsage(state),
        ...balance(state),
        ...(state.payload !== undefined ? { payload: Uint8Array.from(state.payload) } : {}),
    };
}
export async function computeCreditCommitment(
    state: CreditState,
    keyHash?: `0x${string}`
): Promise<`0x${string}`> {
    if (keyHash === undefined) state = normalizeCreditState(state);
    for (const [name, bits] of [
        ["chainId", 64],
        ["protocolAddress", 160],
        ["tokenAddress", 160],
        ["grantId", 128],
        ["expiry", 64],
    ] as const)
        uint(state[name], bits, name);
    normalizeCreditGrantId(state.grantId);
    for (const identity of [state.spenderWalletIdentity, state.ownerWalletIdentity])
        if (!/^0x[0-9a-fA-F]{40}$/.test(identity) || BigInt(identity) === 0n)
            throw new Error("invalid Credit identity");
    if (state.grantId === 0n || state.expiry === 0n)
        throw new Error("Credit grantId and expiry must be positive");
    field(state.nonce, "nonce");
    const hash = keyHash ?? (await computeCreditSharedKeyHash(state.creditSharedKey));
    field(BigInt(hash), "Credit shared key hash");
    return poseidonHash([
        D_CREDIT,
        state.chainId,
        state.protocolAddress,
        BigInt(state.spenderWalletIdentity),
        BigInt(state.ownerWalletIdentity),
        state.tokenAddress,
        state.grantId,
        state.nonce,
        state.expiry,
        BigInt(hash),
        ...CREDIT_POLICY_FIELDS.map((k) => normalizeCreditPolicy(state)[k]),
        balance(state).availableCredit,
        state.unlimited ? 1n : 0n,
        ...CREDIT_USAGE_FIELDS.map((k) => normalizeCreditUsage(state)[k]),
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

/** Tag10: deterministic successor nonce, scoped to the deployment and spend. */
export async function deriveCreditStateNonce(
    chainId: bigint,
    protocolAddress: bigint,
    tokenAddress: bigint,
    creditNullifier: bigint,
    creditSharedKey: bigint
): Promise<bigint> {
    return BigInt(
        await poseidonHash([
            D_CREDIT_STATE_NONCE,
            chainId,
            protocolAddress,
            tokenAddress,
            creditNullifier,
            creditSharedKey,
        ])
    );
}

/** Tag9: additive recovery pad; recoveryAmount = (debit + pad) mod p. */
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
    if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits))
        throw new RangeError(`${name} out of uint${bits} range`);
}

function field(value: bigint, name: string): void {
    if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS)
        throw new RangeError(`${name} out of BN254 field range`);
}

/** Recover a successor using authenticated draw fields, without a decryptable successor delivery. */
export async function recoverCreditState(
    context: ProtocolContext,
    previous: CreditState,
    recovery: CreditStateRecovery
): Promise<CreditState> {
    assertNoteContext(previous, context);
    const nullifier = await computeCreditNullifier(
        context.chainId,
        previous.creditSharedKey,
        await computeCreditCommitment(previous)
    );
    if (nullifier.toLowerCase() !== recovery.creditNullifier.toLowerCase())
        throw new Error("previous Credit nullifier mismatch");
    field(recovery.recoveryAmount, "recoveryAmount");
    const args = [
        context.chainId,
        context.protocolAddress,
        previous.tokenAddress,
        BigInt(nullifier),
        previous.creditSharedKey,
    ] as const;
    const nonce = await deriveCreditStateNonce(...args),
        mask = await computeCreditRecoveryPad(...args);
    const debit = (recovery.recoveryAmount - mask + FIELD_MODULUS) % FIELD_MODULUS;
    uint(debit, 126, "recovered debit");
    if (!debit) throw new Error("invalid recovered debit");
    if (nonce === previous.nonce) throw new Error("state nonce must change");
    const { payload, ...financial } = previous;
    const state = {
        ...financial,
        ...applyCreditDrawUsage(previous, debit, recovery.timestamp),
        nonce,
    };
    if ((await computeCreditCommitment(state)) !== recovery.stateCommitment)
        throw new Error("recovered Credit commitment mismatch");
    return state;
}

export async function deriveCreditState(
    previous: CreditState,
    debit: bigint,
    timestamp: bigint
): Promise<{
    state: CreditState;
    stateCommitment: `0x${string}`;
    nullifier: `0x${string}`;
    recoveryAmount: bigint;
}> {
    const nullifier = await computeCreditNullifier(
        previous.chainId,
        previous.creditSharedKey,
        await computeCreditCommitment(previous)
    );
    const args = [
        previous.chainId,
        previous.protocolAddress,
        previous.tokenAddress,
        BigInt(nullifier),
        previous.creditSharedKey,
    ] as const;
    const nonce = await deriveCreditStateNonce(...args),
        mask = await computeCreditRecoveryPad(...args);
    if (nonce === previous.nonce) throw Error("state nonce must change");
    const state = { ...previous, ...applyCreditDrawUsage(previous, debit, timestamp), nonce };
    return {
        state,
        stateCommitment: await computeCreditCommitment(state),
        nullifier,
        recoveryAmount: (debit + mask) % FIELD_MODULUS,
    };
}
export interface CreditUpdateChanges extends Partial<CreditPolicy> {
    expiry?: bigint;
    unlimited?: boolean;
    increaseAvailableCredit?: bigint;
    decreaseAvailableCredit?: bigint;
}
export async function deriveCreditUpdate(
    previous: CreditState,
    changes: CreditUpdateChanges,
    deadline: bigint
) {
    for (const key of Object.keys(changes))
        if (
            ![
                ...CREDIT_POLICY_FIELDS,
                "expiry",
                "unlimited",
                "increaseAvailableCredit",
                "decreaseAvailableCredit",
            ].includes(key)
        )
            throw Error("unsupported Credit update field");
    const old = normalizeCreditState(previous),
        increase =
            changes.increaseAvailableCredit === undefined ? 0n : changes.increaseAvailableCredit,
        decrease =
            changes.decreaseAvailableCredit === undefined ? 0n : changes.decreaseAvailableCredit;
    uint(increase, 128, "increaseAvailableCredit");
    uint(decrease, 128, "decreaseAvailableCredit");
    if (increase !== 0n && decrease !== 0n)
        throw Error("Credit increase and decrease are mutually exclusive");
    const unlimited = changes.unlimited === undefined ? old.unlimited : changes.unlimited;
    if (typeof unlimited !== "boolean") throw TypeError("unlimited must be boolean");
    let availableCredit = 0n;
    if (unlimited) {
        if (increase !== 0n || decrease !== 0n)
            throw Error("unlimited update cannot adjust available credit");
    } else {
        if (decrease > old.availableCredit)
            throw Error("available credit decrease exceeds balance");
        availableCredit = old.availableCredit + increase - decrease;
        uint(availableCredit, 128, "availableCredit");
    }
    uint(deadline, 64, "deadline");
    const next = {
        ...old,
        ...normalizeCreditPolicy({ ...old, ...changes }),
        expiry: changes.expiry ?? old.expiry,
        availableCredit,
        unlimited,
    };
    if (previous.expiry < deadline || next.expiry < deadline)
        throw Error("expiry before request deadline");
    const nullifier = await computeCreditNullifier(
        previous.chainId,
        previous.creditSharedKey,
        await computeCreditCommitment(previous)
    );
    const nonce = await deriveCreditStateNonce(
        previous.chainId,
        previous.protocolAddress,
        previous.tokenAddress,
        BigInt(nullifier),
        previous.creditSharedKey
    );
    if (nonce === previous.nonce) throw Error("state nonce must change");
    const state = { ...next, nonce };
    return { state, nullifier, stateCommitment: await computeCreditCommitment(state) };
}
