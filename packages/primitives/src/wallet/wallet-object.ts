import { ReceivingAddress } from "../address/receiving-address";
import { MissingCapabilityError } from "../errors";
import { NullifierCapability } from "./capabilities";

/** Public identity and receiving keys. */
export class WalletAddress {
    readonly #address: ReceivingAddress;

    protected constructor(address: ReceivingAddress) {
        this.#address = address;
    }

    get ownerAddress(): `0x${string}` {
        return this.#address.ownerAddress;
    }

    get viewingPublicKey(): Uint8Array {
        return this.#address.viewingPublicKey;
    }

    get clueKey(): Uint8Array {
        return this.#address.clueKey;
    }

    /** Complete 0i receiving address. Owner-only wallets must first resolve their receiving keys. */
    getAddress(): string {
        if (this.#address.kind !== "long") {
            throw new MissingCapabilityError("resolved receiving keys");
        }
        return this.#address.toString();
    }

    getReceivingAddress(): ReceivingAddress {
        return this.#address;
    }

    /** Nullifiers derive from public identity and do not grant spending authority. */
    exportNullifier(): NullifierCapability {
        return NullifierCapability.fromIdentity(this.ownerAddress);
    }

    toJSON() {
        return { ownerAddress: this.ownerAddress, address: this.#address.toString() };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}

/** Address-only wallet. Contains no private keys or private capability methods. */
export class Wallet extends WalletAddress {
    private constructor(address: ReceivingAddress) {
        super(address);
        Object.freeze(this);
    }

    /** Parse a complete 0i address or an EVM owner address without network access. */
    static fromAddress(address: ReceivingAddress | string): Wallet {
        if (typeof address !== "string" && !(address instanceof ReceivingAddress)) {
            throw new TypeError("expected a validated receiving address");
        }
        return new Wallet(typeof address === "string" ? ReceivingAddress.parse(address) : address);
    }
}
