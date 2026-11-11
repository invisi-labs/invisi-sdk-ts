import { ReceivingAddress } from "../address/receiving-address";
import { encodeLongAddress } from "../address/address";
import type { ReceivingKeys } from "../types";
import { NullifierCapability } from "./capabilities";

/** Public identity and receiving keys. */
export class WalletAddress {
    readonly #ownerAddress: `0x${string}`;
    readonly #receivingKeys: ReceivingKeys;

    protected constructor(address: ReceivingAddress) {
        this.#receivingKeys = address.getReceivingKeys();
        this.#ownerAddress = address.ownerAddress;
    }

    get ownerAddress(): `0x${string}` {
        return this.#ownerAddress;
    }

    get viewingPublicKey(): Uint8Array {
        return this.#receivingKeys.viewingPublicKey.slice();
    }

    get clueKey(): Uint8Array {
        return this.#receivingKeys.clueKey.slice();
    }

    /** Encode the complete public receiving material on demand. */
    getAddress(): string {
        return encodeLongAddress({ ownerAddress: this.#ownerAddress, ...this.#receivingKeys });
    }

    getReceivingAddress(): ReceivingAddress {
        return ReceivingAddress.from({ ownerAddress: this.#ownerAddress, ...this.#receivingKeys });
    }

    /** Nullifiers derive from public identity and do not grant spending authority. */
    exportNullifier(): NullifierCapability {
        return NullifierCapability.fromIdentity(this.ownerAddress);
    }

    toJSON() {
        return { ownerAddress: this.ownerAddress, address: this.getAddress() };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}

/** Complete public wallet. Contains no private keys or private capability methods. */
export class Wallet extends WalletAddress {
    private constructor(address: ReceivingAddress) {
        super(address);
        Object.freeze(this);
    }

    /** Parse complete 0i receiving material without network access. */
    static fromAddress(address: ReceivingAddress | string): Wallet {
        if (typeof address !== "string" && !(address instanceof ReceivingAddress)) {
            throw new TypeError("expected a validated receiving address");
        }
        return new Wallet(typeof address === "string" ? ReceivingAddress.parse(address) : address);
    }
}
