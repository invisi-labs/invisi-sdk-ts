import {
    deliveryCodec,
    validateDeliveryCiphertext,
} from "../packages/core/src/delivery/delivery-codec";
import { detectClue } from "../packages/core/src/fmd/fmd";
import {
    validateWalletRequest,
    walletHex,
    walletBytes,
    walletAuthorizationParams,
    walletDecryptionContext,
    type WalletRequest,
    type WalletResponse,
} from "../packages/core/src/wallet/wallet-wire";
import { ReceivingAddress } from "../packages/core/src/address/receiving-address";
import {
    Detector,
    NullifierCapability,
    ViewingCapability,
    WalletAuthorization,
} from "../packages/core/src/wallet/capabilities";
import { deriveWallet, type InvisiWallet } from "../packages/core/src/wallet/wallet";

import { WalletAddress } from "../packages/core/src/wallet/wallet-object";
/** Fixture-only account execution; excluded from published packages. */
export class TestWallet extends WalletAddress {
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

    private static async fromMaterial(raw: InvisiWallet): Promise<TestWallet> {
        try {
            const address = ReceivingAddress.from(raw);
            return new TestWallet(address, {
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
    static async fromPrivateKey(privateKey: string | Uint8Array): Promise<TestWallet> {
        return TestWallet.fromMaterial(await deriveWallet(privateKey));
    }

    async execute(request: WalletRequest): Promise<WalletResponse> {
        const scoped = structuredClone(request);
        validateWalletRequest(scoped);
        if (scoped.ownerAddress !== this.ownerAddress.toLowerCase())
            throw new Error("wallet request identity mismatch");
        let result: unknown;
        switch (scoped.method) {
            case "wallet.public": {
                const authorization = this.#authorization;
                result = {
                    viewingPublicKey: walletHex(this.viewingPublicKey),
                    clueKey: walletHex(this.clueKey),
                    spendingPublicKey: walletHex(authorization.getPublicKey()),
                };
                break;
            }
            case "wallet.detect": {
                const params =
                    scoped.params as import("../packages/core/src/wallet/wallet-wire").WalletParams["wallet.detect"];
                const key = this.#detection.exportKey();
                try {
                    result = {
                        matches: params.clues.map((clue) => detectClue(key, walletBytes(clue))),
                    };
                } finally {
                    key.fill(0);
                }
                break;
            }
            case "wallet.authorize": {
                const authorized = await this.#authorization.authorize(
                    walletAuthorizationParams(
                        scoped.params as import("../packages/core/src/wallet/wallet-wire").WalletParams["wallet.authorize"]
                    )
                );
                result = authorized.withWitness((witness) => ({
                    spendingPublicKey: walletHex(
                        Uint8Array.from([4, ...witness.public_key_x, ...witness.public_key_y])
                    ),
                    signature: walletHex(Uint8Array.from(witness.signature)),
                    digest: authorized.digest,
                }));
                break;
            }
            case "wallet.decryptNote":
            case "wallet.decryptCredit": {
                const typed = scoped as WalletRequest<
                    "wallet.decryptNote" | "wallet.decryptCredit"
                >;
                const context = walletDecryptionContext(typed);
                const envelope = validateDeliveryCiphertext(typed.params.envelope);
                const codec = deliveryCodec(envelope[0]!);
                if (codec.kind === "funds") {
                    const note = await this.#viewing.decryptNote(envelope, context);
                    result = { plaintext: walletHex(codec.encode(note)) };
                } else {
                    const state = await this.#viewing.decryptCredit(
                        envelope,
                        context as import("../packages/core/src/delivery/types").CreditStateDecryptionContext
                    );
                    result = { plaintext: walletHex(codec.encode(state)) };
                }
            }
        }
        return {
            version: 1,
            id: scoped.id,
            ownerAddress: scoped.ownerAddress,
            method: scoped.method,
            result,
        } as WalletResponse;
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
