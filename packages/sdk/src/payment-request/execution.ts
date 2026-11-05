import type { NoteOutputExecutionOptions, PaymentRequest } from "./types";
import { fields, nonce } from "./validation";

/** Apply payer-local decisions to a copy, without changing the encoded request. */
export function applyExecutionOptions(
    request: PaymentRequest,
    execution: NoteOutputExecutionOptions
): PaymentRequest {
    fields(execution, ["nonce", "addressLookup"], "execution options");
    const copy = structuredClone(request);
    const recipient = copy.recipient;
    if (execution.nonce !== undefined) {
        if (recipient.type === "identity")
            throw new TypeError("identity recipient cannot specify nonce");
        nonce(execution.nonce);
        if (recipient.nonce !== undefined && recipient.nonce !== execution.nonce)
            throw new Error("nonce conflicts with the fixed payment request");
        recipient.nonce = execution.nonce;
    }
    if (execution.addressLookup !== undefined) {
        if (recipient.type !== "evm" || recipient.envelope === false)
            throw new TypeError("addressLookup requires an encrypted EVM recipient");
        if (!["chain", "protocol-rpc"].includes(execution.addressLookup))
            throw new TypeError("Invalid addressLookup");
        recipient.addressLookup = execution.addressLookup;
    }
    return copy;
}
