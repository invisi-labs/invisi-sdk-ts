import { ReceivingAddress } from "../address/receiving-address";
import { Detector, ViewingCapability } from "./capabilities";
import { deriveReceivingSecrets } from "./receiving-key-derivation";
import { WalletAddress } from "./wallet-object";

export { buildReceivingKeyMessage } from "./receiving-key-derivation";

export interface ReceivingSignatureInput {
    readonly ownerAddress: string;
    readonly signature: string | Uint8Array;
}

/** Local receiving capabilities and public address derived for a verified EVM owner. */
class ReceivingKeyMaterial extends WalletAddress {
    readonly #viewer: ViewingCapability;
    readonly #detector: Detector;

    constructor(viewer: ViewingCapability, detector: Detector) {
        super(
            ReceivingAddress.from({
                ownerAddress: viewer.ownerAddress,
                viewingPublicKey: viewer.getPublicKey(),
                clueKey: detector.getClueKey(),
            })
        );
        this.#viewer = viewer;
        this.#detector = detector;
        Object.freeze(this);
    }

    getViewer(): ViewingCapability {
        return this.#viewer;
    }

    getDetector(): Detector {
        return this.#detector;
    }
}

export type { ReceivingKeyMaterial };

/** Verify the v1 personal signature and restore viewing and detection capabilities. */
export function deriveReceivingKeysFromSignature({
    ownerAddress,
    signature,
}: ReceivingSignatureInput): ReceivingKeyMaterial {
    const secrets = deriveReceivingSecrets(ownerAddress, signature);
    try {
        return new ReceivingKeyMaterial(
            new ViewingCapability(secrets.ownerAddress, secrets.viewingPrivateKey),
            new Detector(secrets.detectionKey)
        );
    } finally {
        secrets.viewingPrivateKey.fill(0);
        secrets.detectionSeed.fill(0);
        secrets.detectionKey.fill(0);
    }
}
