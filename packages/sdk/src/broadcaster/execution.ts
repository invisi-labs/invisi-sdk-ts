import type { SignedBroadcasterQuote } from "./index";
import type { TransactionProveOptions } from "../transactions/operation-types";

export function resolveQuotedExecution(
    signed: SignedBroadcasterQuote | undefined,
    supplied: TransactionProveOptions
): TransactionProveOptions {
    if (!signed) return { ...supplied };
    const execution = signed.quote.execution;
    if (execution !== "direct" && execution !== "aggregate")
        throw Error("Invalid signed broadcaster execution");
    const required = execution === "direct" ? "single" : "aggregate";
    if (supplied.execution !== undefined && supplied.execution !== required)
        throw Error(`Signed broadcaster quote requires ${execution} execution`);
    return { ...supplied, execution: required };
}
