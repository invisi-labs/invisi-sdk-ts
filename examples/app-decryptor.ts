import type { DeliveryDecryptor } from "@invisi-labs/sdk";

// Replace these callbacks with your App's wallet decryption. Return null only for nonrecipients.
// Operational errors must reject so an incomplete scan cannot advance the wallet checkpoint.
export const decryptor: DeliveryDecryptor = {
    async decryptNote(_envelope, _context) {
        throw new Error("Inject App Note decryption in examples/app-decryptor.ts");
    },
    async decryptCredit(_envelope, _context) {
        throw new Error("Inject App Credit decryption in examples/app-decryptor.ts");
    },
};
