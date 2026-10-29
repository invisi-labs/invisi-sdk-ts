import { encodeMemo } from "./memo";
import { bytesToHex } from "@noble/hashes/utils";
import { computeNoteIdentity, computeNoteCommitment } from "./commitment";
import {
    computeCreditCommitment,
    normalizeCreditPolicy,
    computeCreditSharedKeyHash,
} from "./creditCommitment";
import {
    decryptPrivateTransferNote,
    decryptCreditNote,
    decryptNotePayload,
    decryptCreditPayload,
    exportPayloadKey,
    type NoteBytes,
    type NoteDecryptionContext,
    type CreditNoteDecryptionContext,
} from "./encryption";
import { FIELD_MODULUS } from "./random";
import type { Note, CreditNote, CreditPolicy } from "./types";

/** A Credit commitment opening excludes encrypted memos and the shared recovery/nullifier secret. */
export interface CreditOpening
    extends Omit<CreditNote, "creditSharedKey" | "memo" | keyof CreditPolicy>, CreditPolicy {
    creditSharedKeyHash: `0x${string}`;
}

/** Independently authenticated output data. Core verification alone does not establish inclusion. */
export interface DisclosureOutput {
    chainId: bigint;
    protocolAddress: bigint;
    tokenAddress: bigint;
    outputCommitment: `0x${string}`;
    role: "funds" | "owner" | "spender";
    ciphertext?: NoteBytes | undefined;
}

/** Sensitive transport material: obtain it only through the explicit export() operation. */
export interface DisclosureExport {
    version: 1;
    kind: "note" | "credit";
    method: "opening" | "payload-key";
    context: {
        chainId: string;
        protocolAddress: string;
        tokenAddress: string;
        outputCommitment: `0x${string}`;
    };
    data: Record<string, string>;
}

export type DisclosureResult =
    | { kind: "note"; note: Readonly<Note> }
    | { kind: "credit"; note: Readonly<CreditOpening & { memo?: Uint8Array }> };

const NOTE_FIELDS = ["walletIdentity", "amount", "nonce"] as const;
const CREDIT_FIELDS = [
    "spenderWalletIdentity",
    "ownerWalletIdentity",
    "spenderPayout",
    "ownerPayout",
    "amount",
    "nonce",
    "expiry",
    "creditSharedKeyHash",
    "singleLimit",
    "dailyLimit",
    "monthlyLimit",
    "lastDay",
    "dailySpent",
    "lastMonth",
    "monthlySpent",
] as const;

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid disclosure object");
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
        throw new Error("unexpected disclosure fields");
    return value as Record<string, unknown>;
}

function number(value: unknown, bits: number, label: string): bigint {
    if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits))
        throw new Error(`invalid disclosure ${label}`);
    return value;
}

function decimal(value: unknown, bits: number, label: string): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
        throw new Error(`invalid disclosure ${label}`);
    return number(BigInt(value), bits, label);
}

function hash(value: unknown, label: string, field = true): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
        throw new Error(`invalid disclosure ${label}`);
    if (field && BigInt(value) >= FIELD_MODULUS) throw new Error(`invalid disclosure ${label}`);
    return value.toLowerCase() as `0x${string}`;
}

function owner(value: unknown, label: string): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || BigInt(value) === 0n)
        throw new Error(`invalid disclosure ${label}`);
    return value.toLowerCase() as `0x${string}`;
}

function nonce(value: bigint): bigint {
    if (value < 0n || value >= FIELD_MODULUS) throw new Error("invalid disclosure nonce");
    return value;
}

function context(value: Pick<DisclosureOutput, "chainId" | "protocolAddress" | "tokenAddress">) {
    const result = {
        chainId: number(value.chainId, 64, "chainId"),
        protocolAddress: number(value.protocolAddress, 160, "protocolAddress"),
        tokenAddress: number(value.tokenAddress, 160, "tokenAddress"),
    };
    if (result.protocolAddress === 0n || result.tokenAddress === 0n)
        throw new Error("disclosure addresses must be nonzero");
    return result;
}

function encode(values: Record<string, bigint | string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, value.toString()])
    );
}

async function creditOpening(note: CreditNote): Promise<CreditOpening> {
    const copied = { ...note };
    return {
        ...context(copied),
        ...normalizeCreditPolicy(copied),
        spenderWalletIdentity: owner(copied.spenderWalletIdentity, "spender identity"),
        ownerWalletIdentity: owner(copied.ownerWalletIdentity, "owner identity"),
        spenderPayout: number(copied.spenderPayout, 160, "spender payout"),
        ownerPayout: number(copied.ownerPayout, 160, "owner payout"),
        amount: number(copied.amount, 126, "amount"),
        nonce: nonce(copied.nonce),
        expiry: number(copied.expiry, 64, "expiry"),
        creditSharedKeyHash: await computeCreditSharedKeyHash(copied.creditSharedKey),
    };
}

async function commitment(note: Note | CreditOpening): Promise<`0x${string}`> {
    if ("creditSharedKeyHash" in note) {
        return computeCreditCommitment(
            note.chainId,
            note.spenderWalletIdentity,
            note.ownerWalletIdentity,
            note.spenderPayout,
            note.ownerPayout,
            note.tokenAddress,
            note.amount,
            note.nonce,
            note.expiry,
            note.creditSharedKeyHash,
            note
        );
    }
    return computeNoteCommitment(
        note.chainId,
        await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce),
        note.tokenAddress,
        note.amount
    );
}

/** Scoped disclosure material. Default JSON/inspection is redacted; export() is deliberately sensitive. */
export class Disclosure {
    readonly #material: DisclosureExport;

    private constructor(material: DisclosureExport) {
        this.#material = {
            ...material,
            context: Object.freeze({ ...material.context }),
            data: Object.freeze({ ...material.data }),
        };
        Object.freeze(this.#material);
        Object.freeze(this);
    }

    static async fromNote(value: Note): Promise<Disclosure> {
        const copied = { ...value };
        const note: Note = {
            ...context(copied),
            walletIdentity: owner(copied.walletIdentity, "wallet identity"),
            amount: number(copied.amount, 128, "amount"),
            nonce: nonce(copied.nonce),
        };
        return new Disclosure({
            version: 1,
            kind: "note",
            method: "opening",
            context: {
                ...encode(context(note)),
                outputCommitment: await commitment(note),
            } as DisclosureExport["context"],
            data: encode({
                walletIdentity: note.walletIdentity,
                amount: note.amount,
                nonce: note.nonce,
            }),
        });
    }

    static async fromCredit(value: CreditNote): Promise<Disclosure> {
        const note = await creditOpening(value);
        const data = Object.fromEntries(CREDIT_FIELDS.map((key) => [key, note[key].toString()]));
        return new Disclosure({
            version: 1,
            kind: "credit",
            method: "opening",
            context: {
                ...encode(context(note)),
                outputCommitment: await commitment(note),
            } as DisclosureExport["context"],
            data,
        });
    }

    /** Low-level factory; normally use wallet.getViewer().discloseNote(). */
    static async fromEncryptedNote(
        key: NoteBytes,
        envelope: NoteBytes,
        value: NoteDecryptionContext
    ): Promise<Disclosure> {
        const scoped = { ...value };
        const copied = typeof envelope === "string" ? envelope : Uint8Array.from(envelope);
        const localKey = typeof key === "string" ? key : Uint8Array.from(key);
        try {
            await decryptPrivateTransferNote(localKey, copied, scoped);
            return await Disclosure.fromEnvelope(localKey, copied, scoped, "funds");
        } finally {
            if (localKey instanceof Uint8Array) localKey.fill(0);
        }
    }

    /** Exposes the full selected Credit envelope, including its shared key and receiving snapshots. */
    static async fromEncryptedCredit(
        key: NoteBytes,
        envelope: NoteBytes,
        value: CreditNoteDecryptionContext
    ): Promise<Disclosure> {
        const scoped = { ...value };
        const copied = typeof envelope === "string" ? envelope : Uint8Array.from(envelope);
        const localKey = typeof key === "string" ? key : Uint8Array.from(key);
        try {
            await decryptCreditNote(localKey, copied, scoped);
            return await Disclosure.fromEnvelope(localKey, copied, scoped, scoped.role);
        } finally {
            if (localKey instanceof Uint8Array) localKey.fill(0);
        }
    }

    private static async fromEnvelope(
        key: NoteBytes,
        envelope: NoteBytes,
        scoped: NoteDecryptionContext,
        role: DisclosureOutput["role"]
    ): Promise<Disclosure> {
        const payloadKey = await exportPayloadKey(key, envelope, role !== "funds");
        try {
            return new Disclosure({
                version: 1,
                kind: role === "funds" ? "note" : "credit",
                method: "payload-key",
                context: {
                    ...encode(context(scoped)),
                    outputCommitment: hash(scoped.outputCommitment, "commitment"),
                } as DisclosureExport["context"],
                data: {
                    payloadKey: `0x${bytesToHex(payloadKey)}`,
                    walletIdentity: owner(scoped.walletIdentity, "wallet identity"),
                    role,
                },
            });
        } finally {
            payloadKey.fill(0);
        }
    }

    /** Parse untrusted JSON material; verification against an independent output is still required. */
    static async fromExport(value: unknown): Promise<Disclosure> {
        const root = record(value, ["version", "kind", "method", "context", "data"]);
        if (
            root.version !== 1 ||
            (root.kind !== "note" && root.kind !== "credit") ||
            (root.method !== "opening" && root.method !== "payload-key")
        )
            throw new Error("unsupported disclosure format");
        const rawContext = record(root.context, [
            "chainId",
            "protocolAddress",
            "tokenAddress",
            "outputCommitment",
        ]);
        const scoped = context({
            chainId: decimal(rawContext.chainId, 64, "chainId"),
            protocolAddress: decimal(rawContext.protocolAddress, 160, "protocolAddress"),
            tokenAddress: decimal(rawContext.tokenAddress, 160, "tokenAddress"),
        });
        const outputCommitment = hash(rawContext.outputCommitment, "commitment");
        const fields =
            root.method === "payload-key"
                ? ["payloadKey", "walletIdentity", "role"]
                : root.kind === "note"
                  ? NOTE_FIELDS
                  : CREDIT_FIELDS;
        const raw = record(root.data, fields);
        const data: Record<string, string> = {};
        for (const key of fields) {
            if (key === "role") {
                if (
                    root.kind === "note"
                        ? raw[key] !== "funds"
                        : raw[key] !== "owner" && raw[key] !== "spender"
                )
                    throw new Error("invalid disclosure role");
                data[key] = raw[key] as string;
            } else if (
                key === "payloadKey" ||
                key.endsWith("Identity") ||
                key === "creditSharedKeyHash"
            ) {
                data[key] = key.endsWith("Identity")
                    ? owner(raw[key], key)
                    : hash(raw[key], key, key !== "payloadKey");
            } else {
                const bits = key.endsWith("Payout")
                    ? 160
                    : key === "expiry"
                      ? 64
                      : key === "amount"
                        ? root.kind === "note"
                            ? 128
                            : 126
                        : 254;
                const parsed = decimal(raw[key], bits, key);
                if (key === "nonce") nonce(parsed);
                data[key] = parsed.toString();
            }
        }
        const material: DisclosureExport = {
            version: 1,
            kind: root.kind,
            method: root.method,
            context: { ...encode(scoped), outputCommitment } as DisclosureExport["context"],
            data,
        };
        const result = new Disclosure(material);
        if (material.method === "opening")
            await result.verify({
                ...scoped,
                outputCommitment,
                role: material.kind === "note" ? "funds" : "owner",
            });
        return result;
    }

    getScope() {
        const { version, kind, method } = this.#material;
        return {
            version,
            kind,
            method,
            permitsOwnerSweep: kind === "note",
            revealsNoteConsumption: kind === "note",
            revealsCreditSharedKey: kind === "credit" && method === "payload-key",
            revealsReceivingKeys: kind === "credit" && method === "payload-key",
            revealsMemo: method === "payload-key",
        };
    }

    /** Explicitly export sensitive, JSON-compatible material for a chosen recipient. */
    export(): DisclosureExport {
        return {
            ...this.#material,
            context: { ...this.#material.context },
            data: { ...this.#material.data },
        };
    }

    async verify(value: DisclosureOutput): Promise<DisclosureResult> {
        const output = {
            ...value,
            ciphertext:
                value.ciphertext instanceof Uint8Array
                    ? Uint8Array.from(value.ciphertext)
                    : value.ciphertext,
        };
        const scoped = context(output);
        const material = this.#material;
        for (const field of ["chainId", "protocolAddress", "tokenAddress"] as const) {
            if (scoped[field].toString() !== material.context[field])
                throw new Error("disclosure deployment context mismatch");
        }
        if (hash(output.outputCommitment, "commitment") !== material.context.outputCommitment)
            throw new Error("disclosure output commitment mismatch");
        if (
            material.kind === "note"
                ? output.role !== "funds"
                : output.role !== "owner" && output.role !== "spender"
        )
            throw new Error("disclosure output role mismatch");
        const data = material.data;
        if (material.method === "payload-key") {
            if (output.role !== data.role || output.ciphertext === undefined)
                throw new Error("disclosure requires the selected role envelope");
            const decryption = {
                ...scoped,
                outputCommitment: output.outputCommitment,
                walletIdentity: data.walletIdentity as `0x${string}`,
            };
            if (material.kind === "note")
                return {
                    kind: "note",
                    note: Object.freeze(
                        await decryptNotePayload(
                            data.payloadKey as `0x${string}`,
                            output.ciphertext,
                            decryption
                        )
                    ),
                };
            const state = await decryptCreditPayload(
                data.payloadKey as `0x${string}`,
                output.ciphertext,
                { ...decryption, role: output.role as "owner" | "spender" }
            );
            return {
                kind: "credit",
                note: Object.freeze({
                    ...(await creditOpening(state.note)),
                    ...(state.note.memo === undefined ? {} : { memo: encodeMemo(state.note.memo) }),
                }),
            };
        }
        if (material.kind === "note") {
            const note: Note = {
                ...scoped,
                walletIdentity: data.walletIdentity as `0x${string}`,
                amount: BigInt(data.amount!),
                nonce: BigInt(data.nonce!),
            };
            if ((await commitment(note)) !== material.context.outputCommitment)
                throw new Error("disclosure opening commitment mismatch");
            return { kind: "note", note: Object.freeze(note) };
        }
        const note: CreditOpening = {
            ...scoped,
            spenderWalletIdentity: data.spenderWalletIdentity as `0x${string}`,
            ownerWalletIdentity: data.ownerWalletIdentity as `0x${string}`,
            spenderPayout: BigInt(data.spenderPayout!),
            ownerPayout: BigInt(data.ownerPayout!),
            amount: BigInt(data.amount!),
            nonce: BigInt(data.nonce!),
            expiry: BigInt(data.expiry!),
            ...normalizeCreditPolicy(
                Object.fromEntries(
                    [
                        "singleLimit",
                        "dailyLimit",
                        "monthlyLimit",
                        "lastDay",
                        "dailySpent",
                        "lastMonth",
                        "monthlySpent",
                    ].map((k) => [k, BigInt(data[k]!)])
                )
            ),
            creditSharedKeyHash: data.creditSharedKeyHash as `0x${string}`,
        };
        if ((await commitment(note)) !== material.context.outputCommitment)
            throw new Error("disclosure opening commitment mismatch");
        return { kind: "credit", note: Object.freeze(note) };
    }

    toJSON() {
        return { capability: "disclosure", ...this.getScope() };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
