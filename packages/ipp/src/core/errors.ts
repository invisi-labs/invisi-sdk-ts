/** Error details deliberately exclude response bodies, request URLs and credentials. */
export class IppError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable = false,
        readonly status?: number,
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = "IppError";
    }
}
export function invalid(): never {
    throw new IppError("invalid_message", "Invalid IPP message or context.");
}
