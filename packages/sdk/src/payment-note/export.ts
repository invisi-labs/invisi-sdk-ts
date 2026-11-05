import type { PreparedOutput } from "../transactions/operation-types";
import { encodePaymentNote } from "./codec";

/** Export the complete opening; identity-only outputs intentionally have no opening. */
export function exportPaymentNote(output: PreparedOutput): string {
    const note = output.note;
    if (output.recipient.type === "identity" || !note)
        throw new Error("Identity outputs cannot export an IPN");
    return encodePaymentNote({
        chainId: note.chainId,
        protocolAddress: output.context.protocolAddress,
        tokenAddress: output.context.tokenAddress,
        amount: note.amount,
        ownerAddress: note.ownerAddress,
        nonce: note.nonce,
        commitment: output.commitment,
    });
}
