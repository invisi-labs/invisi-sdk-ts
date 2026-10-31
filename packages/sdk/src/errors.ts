import { MissingCapabilityError } from "@invisi-labs/core";

/** Stable codes returned by public SDK prepare* methods; inspect details instead of matching messages. */
export type InvisiErrorCode =
    /**
     * Other preparation failure, such as invalid amounts, expired deadlines,
     * or conflicting registration state. Inspect message and cause.
     */
    | "PREPARATION_FAILED"
    /**
     * Required infrastructure or permissions were not supplied.
     * The capability field identifies what is missing.
     */
    | "MISSING_CAPABILITY"
    /**
     * The recipient string is not a valid full 0i address or nonzero EVM owner address.
     * No registration lookup is attempted for this invalid string.
     */
    | "INVALID_RECIPIENT"
    /**
     * A successful lookup found no receiving keys for this short 0x owner
     * at the queried state. Indexed data may lag behind the latest chain state.
     * Full 0i addresses contain receiving keys and do not require registration.
     */
    | "EVM_ADDRESS_NOT_REGISTERED"
    /**
     * Recipient lookup failed or returned invalid keys. Inspect cause.
     * Registration status is unknown; this does not mean the owner is unregistered.
     */
    | "RECIPIENT_LOOKUP_FAILED";

export interface InvisiErrorDetails {
    operation?: string;
    address?: string;
    /** Zero-based index into the caller's outputs array, excluding automatic change. */
    outputIndex?: number;
    field?: string;
    capability?: string;
    cause?: unknown;
}

/** Stable application-facing preparation failure with the original cause. */
export class InvisiError extends Error {
    readonly code: InvisiErrorCode;
    readonly operation: string | undefined;
    readonly address: string | undefined;
    readonly outputIndex: number | undefined;
    readonly field: string | undefined;
    readonly capability: string | undefined;

    constructor(code: InvisiErrorCode, message: string, details: InvisiErrorDetails = {}) {
        super(message, { cause: details.cause });
        this.name = "InvisiError";
        this.code = code;
        this.operation = details.operation;
        this.address = details.address;
        this.outputIndex = details.outputIndex;
        this.field = details.field;
        this.capability = details.capability;
    }
}

/** Keep nested failures intact; do not infer business codes from English messages. */
export async function prepareWithErrors<T>(
    operation: string,
    prepare: () => Promise<T>
): Promise<T> {
    try {
        return await prepare();
    } catch (cause) {
        if (cause instanceof InvisiError) {
            if (cause.operation) throw cause;
            throw new InvisiError(cause.code, cause.message, {
                operation,
                ...(cause.address === undefined ? {} : { address: cause.address }),
                ...(cause.outputIndex === undefined ? {} : { outputIndex: cause.outputIndex }),
                ...(cause.field === undefined ? {} : { field: cause.field }),
                ...(cause.capability === undefined ? {} : { capability: cause.capability }),
                cause: cause.cause,
            });
        }
        throw new InvisiError(
            cause instanceof MissingCapabilityError ? "MISSING_CAPABILITY" : "PREPARATION_FAILED",
            cause instanceof Error ? cause.message : "Transaction preparation failed",
            {
                operation,
                cause,
                ...(cause instanceof MissingCapabilityError
                    ? { capability: cause.capability }
                    : {}),
            }
        );
    }
}
