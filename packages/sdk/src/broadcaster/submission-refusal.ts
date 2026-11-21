import { BroadcasterRpcError } from "@invisi-labs/rpc/broadcaster";
import { InvisiError, type InvisiErrorCode } from "../errors";

/** Only these structured RPC code/reason pairs guarantee that this request was not sent. */
export function broadcasterSubmissionRefusal(cause: unknown): InvisiError | undefined {
    if (!(cause instanceof BroadcasterRpcError)) return undefined;
    const reason = cause.message.split(":", 1)[0];
    if (
        (cause.code === -32024 && reason === "CREDIT_PERIOD_CHANGED") ||
        (cause.code === -32025 && reason === "INSUFFICIENT_EXECUTION_SLACK") ||
        (cause.code === -32026 && reason === "CREDIT_PERIOD_ENDING")
    )
        return new InvisiError(reason, cause.message, { cause });
    return undefined;
}

/** Acknowledging a refusal never authorizes resubmitting the unchanged statement. */
export function assertBroadcasterNotRefused(reason: InvisiErrorCode | undefined): void {
    if (reason)
        throw new InvisiError(
            reason,
            "Broadcaster refused this statement; abandon it and prepare a fresh operation before authorizing and proving again"
        );
}
