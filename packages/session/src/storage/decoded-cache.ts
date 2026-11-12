import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { WalletRecordCodec } from "./store";
import type { WalletState } from "./state";

/** Store-instance memory only. Revisions and ciphertext identity are checked on every backend read. */
export class DecodedRecordCache implements WalletRecordCodec {
    readonly #entries = new Map<
        string,
        { revision: number; digest: string; value: WalletState; bytes: number }
    >();
    #bytes = 0;
    constructor(readonly codec: WalletRecordCodec) {}
    encode(value: WalletState, context: { key: string; revision: number }) {
        return this.codec.encode(value, context);
    }
    async decode(
        data: Uint8Array,
        context: { key: string; revision: number }
    ): Promise<WalletState> {
        const input = Uint8Array.from(data);
        context = { ...context };
        const digest = bytesToHex(sha256(input));
        const cached = this.#entries.get(context.key);
        if (cached?.revision === context.revision && cached.digest === digest) {
            this.#entries.delete(context.key);
            this.#entries.set(context.key, cached);
            return structuredClone(cached.value);
        }
        const value = await this.codec.decode(input, context);
        // Never replace authenticated state on a failed decode or retain an oversized row.
        const previous = this.#entries.get(context.key);
        if (previous) {
            this.#entries.delete(context.key);
            this.#bytes -= previous.bytes;
        }
        if (input.byteLength <= 8 * 1024 * 1024) {
            this.#entries.set(context.key, {
                revision: context.revision,
                digest,
                value: structuredClone(value),
                bytes: input.byteLength,
            });
            this.#bytes += input.byteLength;
            while (this.#entries.size > 512 || this.#bytes > 8 * 1024 * 1024) {
                const key = this.#entries.keys().next().value!;
                this.#bytes -= this.#entries.get(key)!.bytes;
                this.#entries.delete(key);
            }
        }
        return value;
    }
}
