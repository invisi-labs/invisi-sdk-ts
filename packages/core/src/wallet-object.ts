import { deriveWallet, type InvisiWallet } from "./wallet";
import {
    ViewingCapability,
    Detector,
    NullifierCapability,
    WalletAuthorization,
} from "./capabilities";
import { ReceivingAddress } from "./receiving-address";
import { MissingCapabilityError } from "./errors";

/** Local wallet keys and explicit permission exports; no network or storage side effects. */
export class Wallet {
    readonly #address: ReceivingAddress;
    readonly #viewing: ViewingCapability | undefined;
    readonly #detection: Detector | undefined;
    readonly #nullifier: NullifierCapability | undefined;
    readonly #authorization: WalletAuthorization | undefined;

    private constructor(
        address: ReceivingAddress,
        capabilities: {
            viewing?: ViewingCapability;
            detection?: Detector;
            nullifier?: NullifierCapability;
            authorization?: WalletAuthorization;
        } = {}
    ) {
        this.#address = address;
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
                    raw.walletIdentity,
                    raw.viewingPrivateKey,
                    raw.viewingPublicKey
                ),
                detection: new Detector(raw.detectionKey),
                nullifier: NullifierCapability.fromIdentity(raw.walletIdentity),
                authorization: await WalletAuthorization.fromMaterial(
                    raw.walletIdentity,
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

    static fromAddress(address: ReceivingAddress | string): Wallet {
        if (typeof address !== "string" && !(address instanceof ReceivingAddress)) {
            throw new TypeError("expected a validated receiving address");
        }
        return new Wallet(typeof address === "string" ? ReceivingAddress.parse(address) : address);
    }

    get walletIdentity(): `0x${string}` {
        return this.#address.walletIdentity;
    }

    /** The checksummed EVM owner; available without receiving keys or a registry lookup. */
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

    getViewer(): ViewingCapability {
        if (!this.#viewing) {
            throw new MissingCapabilityError("viewing");
        }
        return this.#viewing;
    }

    getDetector(): Detector {
        if (!this.#detection) {
            throw new MissingCapabilityError("detection");
        }
        return this.#detection;
    }

    exportNullifier(): NullifierCapability {
        return this.#nullifier ?? NullifierCapability.fromIdentity(this.walletIdentity);
    }

    exportAuthorization(): WalletAuthorization {
        if (!this.#authorization) {
            throw new MissingCapabilityError("wallet authorization");
        }
        return this.#authorization;
    }

    toJSON() {
        return { walletIdentity: this.walletIdentity, address: this.#address.toString() };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
