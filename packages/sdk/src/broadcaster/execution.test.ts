import { describe, expect, it } from "vitest";
import type { SignedBroadcasterQuote } from "./index";
import { resolveQuotedExecution } from "./execution";

function quote(execution: "direct" | "aggregate"): SignedBroadcasterQuote {
    return {
        quote: {
            execution,
            token: "0x" + "11".repeat(20),
            feeRecipient: "0x" + "22".repeat(20),
            feeAmount: "1",
            deadline: "1",
            maxGas: "1",
            requestHash: "0x" + "33".repeat(32),
        },
        signature: "0x",
    };
}

describe("quoted proving execution", () => {
    it("follows signed execution while preserving all proving options", () => {
        const signal = new AbortController().signal;
        expect(resolveQuotedExecution(quote("aggregate"), { signal })).toEqual({
            execution: "aggregate",
            signal,
        });
        expect(resolveQuotedExecution(quote("direct"), {})).toEqual({ execution: "single" });
        expect(resolveQuotedExecution(undefined, {})).toEqual({});
        expect(resolveQuotedExecution(undefined, { execution: "aggregate" })).toEqual({
            execution: "aggregate",
        });
    });
    it("accepts matching explicit choices and rejects overrides", () => {
        expect(
            resolveQuotedExecution(quote("aggregate"), { execution: "aggregate" }).execution
        ).toBe("aggregate");
        expect(resolveQuotedExecution(quote("direct"), { execution: "single" }).execution).toBe(
            "single"
        );
        expect(() => resolveQuotedExecution(quote("direct"), { execution: "aggregate" })).toThrow(
            /direct/
        );
        expect(() => resolveQuotedExecution(quote("aggregate"), { execution: "single" })).toThrow(
            /aggregate/
        );
        const invalid = quote("direct");
        (invalid.quote as { execution: string }).execution = "unknown";
        expect(() => resolveQuotedExecution(invalid, {})).toThrow(/execution/);
    });
});
