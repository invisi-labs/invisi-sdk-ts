import {
    MissingCapabilityError,
    ReceivingAddress,
    type ReceivingKeyLookup,
} from "@invisi-labs/core";
import { InvisiError, type InvisiErrorDetails } from "../errors";

/** Resolve once during preparation; prepared deliveries keep this public key snapshot. */
export async function resolveRecipient(
    address: string,
    lookup: ReceivingKeyLookup | undefined,
    details: Pick<InvisiErrorDetails, "field" | "outputIndex"> = {}
): Promise<ReceivingAddress> {
    const context = { ...details, address };
    let recipient: ReceivingAddress;
    try {
        recipient = ReceivingAddress.parse(address);
    } catch (cause) {
        throw new InvisiError("INVALID_RECIPIENT", "Invalid recipient address", {
            ...context,
            cause,
        });
    }
    if (recipient.kind === "long") return recipient;
    if (!lookup) {
        throw new InvisiError("MISSING_CAPABILITY", "Missing registry lookup capability", {
            ...context,
            capability: "registry lookup",
        });
    }
    let keys: Awaited<ReturnType<ReceivingKeyLookup>>;
    try {
        keys = await lookup(recipient.ownerAddress);
    } catch (cause) {
        if (cause instanceof MissingCapabilityError) {
            throw new InvisiError("MISSING_CAPABILITY", cause.message, {
                ...context,
                cause,
                capability: cause.capability,
            });
        }
        throw new InvisiError("RECIPIENT_LOOKUP_FAILED", "Recipient registry lookup failed", {
            ...context,
            cause,
        });
    }
    if (keys == null) {
        throw new InvisiError(
            "EVM_ADDRESS_NOT_REGISTERED",
            "EVM address has no registered receiving keys",
            context
        );
    }
    try {
        return ReceivingAddress.from({
            ownerAddress: recipient.ownerAddress,
            viewingPublicKey: keys.viewingPublicKey,
            clueKey: keys.clueKey,
        });
    } catch (cause) {
        throw new InvisiError(
            "RECIPIENT_LOOKUP_FAILED",
            "Registry returned invalid receiving keys",
            { ...context, cause }
        );
    }
}
