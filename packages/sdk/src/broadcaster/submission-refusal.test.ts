import { expect, it } from "vitest";
import { BroadcasterRpcError } from "@invisi-labs/rpc/broadcaster";
import { broadcasterSubmissionRefusal } from "./submission-refusal";

it.each([
    [-32024, "CREDIT_PERIOD_CHANGED"],
    [-32025, "INSUFFICIENT_EXECUTION_SLACK"],
    [-32026, "CREDIT_PERIOD_ENDING"],
] as const)("classifies only the structured submission refusal %s", (code, reason) => {
    const error = new BroadcasterRpcError(code, reason + ": reprepare");
    expect(broadcasterSubmissionRefusal(error)).toMatchObject({ code: reason, cause: error });
});

it.each([
    Error("CREDIT_PERIOD_CHANGED: reprepare"),
    { code: -32024, message: "CREDIT_PERIOD_CHANGED: reprepare" },
    new BroadcasterRpcError(-32024, "CREDIT_PERIOD_ENDING: reprepare"),
    new BroadcasterRpcError(-32025, "CREDIT_PERIOD_CHANGED: reprepare"),
    new BroadcasterRpcError(-32000, "CREDIT_PERIOD_CHANGED: reprepare"),
    new BroadcasterRpcError(-32024, "prefix CREDIT_PERIOD_CHANGED: reprepare"),
    new BroadcasterRpcError(-32024, "CREDIT_PERIOD_CHANGED elsewhere"),
    new BroadcasterRpcError(-32024, "CREDIT_PERIOD_CHANGED : reprepare"),
])("leaves unrecognized errors uncertain %#", (error) => {
    expect(broadcasterSubmissionRefusal(error)).toBeUndefined();
});
