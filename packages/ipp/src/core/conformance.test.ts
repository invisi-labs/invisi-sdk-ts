import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
    parseIppJson,
    parsePaymentSession,
    parsePaymentRequest,
    parseCheckout,
    parseCheckoutInput,
    parseCredential,
} from "../index";

interface Vector {
    name: string;
    kind: "session" | "request" | "checkout" | "input" | "credential";
    valid: boolean;
    json: string;
}
const vectors = JSON.parse(
    readFileSync(new URL("../../../../test-support/ipp-wire-vectors.json", import.meta.url), "utf8")
) as { origin: string; cases: Vector[] };

it.each(vectors.cases)("shared wire conformance: $name", (vector) => {
    const parse = () => {
        const value = parseIppJson(vector.json);
        switch (vector.kind) {
            case "session":
                return parsePaymentSession(value, vectors.origin);
            case "request":
                return parsePaymentRequest(value, vectors.origin);
            case "checkout":
                return parseCheckout(value);
            case "input":
                return parseCheckoutInput(value);
            case "credential":
                return parseCredential(value);
        }
    };
    if (vector.valid) expect(parse).not.toThrow();
    else expect(parse).toThrow();
});
