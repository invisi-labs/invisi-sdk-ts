import type { DeliveryDecryptor } from "@invisi-labs/sdk";

// Replace these callbacks with your App's wallet decryption. Return null only for nonrecipients.
// Return { status: "authentication-failed" } for ambiguous AEAD failure, never null.
// Operational errors reject the batch; an optional native detect callback receives full context and clue.
export const decryptor: DeliveryDecryptor = {
    async decryptNote(_envelope, _context) {
        throw new Error("Inject App Note decryption in examples/app-decryptor.ts");
    },
    async decryptCredit(_envelope, _context) {
        throw new Error("Inject App Credit decryption in examples/app-decryptor.ts");
    },
};
