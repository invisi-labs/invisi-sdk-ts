declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** BN254 scalar field modulus. */
export const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function sampleField(nonzero: boolean): bigint {
    const bytes = new Uint8Array(32);
    for (;;) {
        crypto.getRandomValues(bytes);
        const candidate = BigInt(
            "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
        );
        if (candidate < FIELD_MODULUS && (!nonzero || candidate !== 0n)) return candidate;
    }
}

/** Uniform canonical BN254 nonce, sampled using browser/Node Web Crypto. */
export function generateNonce(): bigint {
    return sampleField(false);
}

/** Independent shared Credit secret. Never derive it from a note/master secret. */
export function generateCreditSharedKey(): bigint {
    return sampleField(true);
}
