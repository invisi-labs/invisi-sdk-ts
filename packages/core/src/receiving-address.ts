import {
    decodeAddress,
    encodeLongAddress,
    encodeShortAddress,
    type ReceivingAddress as ReceivingData,
    type ReceivingKeyLookup,
} from "./address";
import { MissingCapabilityError } from "./errors";
import type { ReceivingKeys } from "./types";

/** Validated public receiving material. A short address requires an explicit resolver. */
export class ReceivingAddress {
    readonly #text: string;

    private constructor(text: string) {
        const decoded = decodeAddress(text);
        this.#text = decoded.kind === "short" ? encodeShortAddress(decoded.walletIdentity) : text;
        Object.freeze(this);
    }

    static parse(text: string): ReceivingAddress {
        return new ReceivingAddress(text);
    }

    static from(recipient: ReceivingData): ReceivingAddress {
        return new ReceivingAddress(encodeLongAddress(recipient));
    }

    static fromIdentity(identity: bigint | `0x${string}`): ReceivingAddress {
        return new ReceivingAddress(encodeShortAddress(identity));
    }

    get walletIdentity(): `0x${string}` {
        return decodeAddress(this.#text).walletIdentity;
    }

    get ownerAddress(): `0x${string}` {
        return encodeShortAddress(this.walletIdentity) as `0x${string}`;
    }

    get kind(): "long" | "short" {
        return decodeAddress(this.#text).kind;
    }

    getReceivingKeys(): ReceivingKeys {
        const decoded = decodeAddress(this.#text);
        if (decoded.kind === "short") {
            throw new MissingCapabilityError("resolved receiving keys");
        }
        return { viewingPublicKey: decoded.viewingPublicKey, clueKey: decoded.clueKey };
    }

    async resolve(lookup?: ReceivingKeyLookup): Promise<ReceivingAddress> {
        if (this.kind === "long") {
            return this;
        }
        if (!lookup) {
            throw new MissingCapabilityError("explicit registry lookup");
        }
        const keys = await lookup(this.walletIdentity);
        if (!keys) {
            throw new Error("wallet identity is not registered");
        }
        return ReceivingAddress.from({
            walletIdentity: this.walletIdentity,
            viewingPublicKey: keys.viewingPublicKey,
            clueKey: keys.clueKey,
        });
    }

    get viewingPublicKey(): Uint8Array {
        return this.getReceivingKeys().viewingPublicKey;
    }

    get clueKey(): Uint8Array {
        return this.getReceivingKeys().clueKey;
    }

    toString(): string {
        return this.#text;
    }

    toJSON(): string {
        return this.#text;
    }
}
