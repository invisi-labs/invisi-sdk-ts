import { deriveWallet, type InvisiWallet } from "./wallet";
import {
    ViewingCapability,
    Detector,
    NullifierCapability,
    WalletAuthorization,
} from "./capabilities";
import { ReceivingAddress } from "./receiving-address";
import { MissingCapabilityError } from "./errors";

/** Public identity and receiving keys shared by both wallet types. */
class WalletAddress {
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
export class PublicWallet extends WalletAddress {
    private constructor(address: ReceivingAddress) {
        super(address);
        Object.freeze(this);
    }

    /** Parse a complete 0i address or an EVM owner address without network access. */
    static fromAddress(address: ReceivingAddress | string): PublicWallet {
        if (typeof address !== "string" && !(address instanceof ReceivingAddress)) {
            throw new TypeError("expected a validated receiving address");
        }
        return new PublicWallet(
            typeof address === "string" ? ReceivingAddress.parse(address) : address
        );
    }
}

/** Local wallet keys and explicit permission exports; no network or storage side effects. */
export class Wallet extends WalletAddress {
    readonly #viewing: ViewingCapability;
    readonly #detection: Detector;
    readonly #nullifier: NullifierCapability;
    readonly #authorization: WalletAuthorization;

    private constructor(
        address: ReceivingAddress,
        capabilities: {
            viewing: ViewingCapability;
            detection: Detector;
            nullifier: NullifierCapability;
            authorization: WalletAuthorization;
        }
    ) {
        super(address);
        this.#viewing = capabilities.viewing;
        this.#detection = capabilities.detection;
        this.#nullifier = capabilities.nullifier;
        this.#authorization = capabilities.authorization;
        Object.freeze(this);
    }

    private static async fromMaterial(raw: InvisiWallet): Promise<Wallet> {
        try {
            const address = ReceivingAddress.from(raw);
            return new Wallet(address, {
                viewing: new ViewingCapability(
                    raw.ownerAddress,
                    raw.viewingPrivateKey,
                    raw.viewingPublicKey
                ),
                detection: new Detector(raw.detectionKey),
                nullifier: NullifierCapability.fromIdentity(raw.ownerAddress),
                authorization: await WalletAuthorization.fromMaterial(
                    raw.ownerAddress,
                    raw.spendingPrivateKey
                ),
            });
        } finally {
            raw.spendingPrivateKey.fill(0);
            raw.viewingPrivateKey.fill(0);
            raw.detectionSeed.fill(0);
            raw.detectionKey.fill(0);
        }
    }

    /** Restore from the EVM account key; the caller owns mnemonic derivation and backup. */
    static async fromPrivateKey(privateKey: string | Uint8Array): Promise<Wallet> {
        return Wallet.fromMaterial(await deriveWallet(privateKey));
    }

    getViewer(): ViewingCapability {
        return this.#viewing;
    }

    getDetector(): Detector {
        return this.#detection;
    }

    exportNullifier(): NullifierCapability {
        return this.#nullifier;
    }

    exportAuthorization(): WalletAuthorization {
        return this.#authorization;
    }
}
