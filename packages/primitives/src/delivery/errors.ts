/** AEAD failure is ambiguous: wrong recipient key, wrong context or damaged ciphertext. */
export class DeliveryAuthenticationError extends Error {
    constructor(cause?: unknown) {
        super("delivery authentication failed", { cause });
        this.name = "DeliveryAuthenticationError";
    }
}
