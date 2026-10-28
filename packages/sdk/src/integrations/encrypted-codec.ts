import {
    serializeState,
    deserializeState,
    type WalletState,
    type WalletRecordCodec,
} from "../session";
/** Caller-owned, nonextractable AES-GCM key. The SDK does not persist the key. */
export class EncryptedWalletCodec implements WalletRecordCodec {
    readonly #key: CryptoKey;
    private constructor(key: CryptoKey) {
        this.#key = key;
    }
    static fromKey(key: CryptoKey): EncryptedWalletCodec {
        if (
            key.type !== "secret" ||
            key.algorithm.name !== "AES-GCM" ||
            (key.algorithm as AesKeyAlgorithm).length !== 256 ||
            !key.usages.includes("encrypt") ||
            !key.usages.includes("decrypt")
        )
            throw new Error("wallet record key must support AES-256-GCM encryption and decryption");
        return new EncryptedWalletCodec(key);
    }
    static async fromBytes(key: Uint8Array): Promise<EncryptedWalletCodec> {
        if (key.length !== 32) throw new Error("wallet record encryption requires 32 key bytes");
        const copy = Uint8Array.from(key);
        try {
            return EncryptedWalletCodec.fromKey(
                await crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, [
                    "encrypt",
                    "decrypt",
                ])
            );
        } finally {
            copy.fill(0);
        }
    }
    private aad(context: { key: string; revision: number }): Uint8Array<ArrayBuffer> {
        if (!Number.isSafeInteger(context.revision) || context.revision < 1)
            throw new Error("invalid encrypted record revision");
        return new TextEncoder().encode(
            `Invisi.WalletRecord.v1\0${context.revision}\0${context.key}`
        );
    }
    async encode(
        state: WalletState,
        context: { key: string; revision: number }
    ): Promise<Uint8Array> {
        const iv = crypto.getRandomValues(new Uint8Array(12)),
            plain = Uint8Array.from(serializeState(state));
        try {
            const encrypted = new Uint8Array(
                await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv, additionalData: this.aad(context) },
                    this.#key,
                    plain
                )
            );
            const out = new Uint8Array(13 + encrypted.length);
            out[0] = 1;
            out.set(iv, 1);
            out.set(encrypted, 13);
            return out;
        } finally {
            plain.fill(0);
        }
    }
    async decode(
        data: Uint8Array,
        context: { key: string; revision: number }
    ): Promise<WalletState> {
        if (data.length < 29 || data[0] !== 1)
            throw new Error("wallet record authentication failed");
        let plain: Uint8Array;
        try {
            plain = new Uint8Array(
                await crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: Uint8Array.from(data.subarray(1, 13)),
                        additionalData: this.aad(context),
                    },
                    this.#key,
                    Uint8Array.from(data.subarray(13))
                )
            );
        } catch {
            throw new Error("wallet record authentication failed");
        }
        try {
            return deserializeState(plain);
        } finally {
            plain.fill(0);
        }
    }
    toJSON() {
        return { walletRecordCodec: "AES-256-GCM" };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
