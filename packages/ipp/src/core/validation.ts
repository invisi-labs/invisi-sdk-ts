import { IppError, invalid } from "./errors";
import { methodValidation } from "./methods";
import {
    object,
    record,
    text,
    number,
    timestamp,
    apiUrl,
    link,
    header,
    mode,
    status,
    bearer,
    assertNoSecret,
} from "./values";
import type { Checkout, CheckoutInput, Credential, Option, PaymentSession, Request } from "./types";

function options(value: unknown, selectedMode: "payment" | "credit"): void {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) return invalid();
    const ids = new Set<string>();
    for (const candidate of value) {
        const option = record(candidate);
        const id = text(option.id);
        if (ids.has(id)) return invalid();
        ids.add(id);
        methodValidation(option.method).option(option, selectedMode);
    }
}
function receipt(value: unknown, selectedMode: "payment" | "credit", options: Option[]): void {
    const methods = new Set(options.map((option) => option.method));
    for (const method of methods) {
        try {
            methodValidation(method).receipt(value, selectedMode);
            return;
        } catch (error) {
            if (!(error instanceof IppError) || error.code !== "invalid_message") throw error;
        }
    }
    return invalid();
}

export function parsePaymentSession(value: unknown, origin?: string): PaymentSession {
    const s = object(
        value,
        [
            "ippVersion",
            "type",
            "mode",
            "sessionId",
            "status",
            "merchant",
            "options",
            "activeRequestId",
            "createdAt",
            "expiresAt",
            "links",
            "failureReason",
            "receipt",
            "evidenceStatus",
            "exceptionSummary",
        ],
        ["description"]
    );
    header(s, "payment_session");
    mode(s.mode);
    text(s.sessionId);
    status(s, true);
    text(object(s.merchant, ["name"]).name);
    if (s.description !== null && s.description !== undefined) text(s.description);
    options(s.options, s.mode);
    if (timestamp(s.expiresAt) <= timestamp(s.createdAt)) return invalid();
    const links = object(s.links, ["confirm", "request"]);
    link(links.confirm, "POST", origin);
    if (s.activeRequestId === null) {
        if (links.request !== null || !["open", "failed"].includes(s.status as string))
            return invalid();
    } else {
        text(s.activeRequestId);
        if (s.status === "open") return invalid();
        link(links.request, "GET", origin);
    }
    if (s.status === "succeeded") {
        receipt(s.receipt, s.mode, s.options as Option[]);
        if (!["confirmed", "reconciling", "disputed"].includes(s.evidenceStatus as string))
            return invalid();
    } else if (s.receipt !== null || s.evidenceStatus !== null) return invalid();
    const e = object(s.exceptionSummary, ["count", "unresolvedCount"]);
    number(e.count, Number.MAX_SAFE_INTEGER);
    if (number(e.unresolvedCount, Number.MAX_SAFE_INTEGER) > (e.count as number)) return invalid();
    const session = structuredClone(s);
    if (session.description === null) delete session.description;
    return session as unknown as PaymentSession;
}

export function parsePaymentRequest(value: unknown, origin?: string): Request {
    const candidate = record(value);
    const validator = methodValidation(candidate.method);
    const raw = object(
        value,
        [
            "ippVersion",
            "type",
            "mode",
            "method",
            "sessionId",
            "requestId",
            "optionId",
            "status",
            "createdAt",
            "expiresAt",
            "links",
            "failureReason",
        ],
        validator.requestFields
    );
    mode(raw.mode);
    header(raw, raw.mode === "payment" ? "payment_request" : "credit_request");
    for (const k of ["sessionId", "requestId", "optionId"]) text(raw[k]);
    status(raw);
    if (timestamp(raw.expiresAt) <= timestamp(raw.createdAt)) return invalid();
    link(object(raw.links, ["credentials"]).credentials, "POST", origin);
    validator.request(raw);
    return structuredClone(raw) as unknown as Request;
}

export function assertRequestMatchesSession(request: Request, session: PaymentSession): void {
    if (
        request.sessionId !== session.sessionId ||
        request.mode !== session.mode ||
        (session.activeRequestId && session.activeRequestId !== request.requestId)
    )
        return invalid();
    const option = session.options.find((o) => o.id === request.optionId);
    if (!option || option.method !== request.method) return invalid();
    methodValidation(request.method).match(request, option);
}

export function parseCheckoutEntry(value: string): { sessionUrl: string; token: string } {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return invalid();
    }
    if (url.protocol !== "https:" || url.username || url.password || !url.hash) return invalid();
    try {
        decodeURIComponent(url.hash.slice(1));
    } catch {
        return invalid();
    }
    const base = apiUrl(value.slice(0, value.indexOf("#")));
    const params = new URLSearchParams(url.hash.slice(1));
    if (
        [...params.keys()].length !== 2 ||
        params.getAll("sessionUrl").length !== 1 ||
        params.getAll("token").length !== 1
    )
        return invalid();
    const sessionUrl = apiUrl(params.get("sessionUrl"));
    const token = bearer(params.get("token"));
    assertNoSecret(base, token);
    assertNoSecret(sessionUrl, token);
    return { sessionUrl, token };
}

export function parseCheckout(value: unknown): Checkout {
    const c = object(value, ["ippVersion", "type", "sessionUrl", "checkoutUrl", "expiresAt"]);
    header(c, "checkout");
    apiUrl(c.sessionUrl);
    timestamp(c.expiresAt);
    const entry = parseCheckoutEntry(text(c.checkoutUrl));
    if (entry.sessionUrl !== c.sessionUrl) return invalid();
    return structuredClone(c) as unknown as Checkout;
}

export function parseCheckoutInput(value: unknown, now?: number): CheckoutInput {
    const c = object(value, ["ippVersion", "mode", "options", "expiresAt"], ["description"]);
    if (c.ippVersion !== 1) return invalid();
    mode(c.mode);
    options(c.options, c.mode);
    if (c.description !== undefined) text(c.description);
    const expires = timestamp(c.expiresAt);
    if (now !== undefined && expires <= now) return invalid();
    return structuredClone(c) as unknown as CheckoutInput;
}

export function parseCredential(value: unknown, request?: Request): Credential {
    const c = object(value, [
        "ippVersion",
        "type",
        "mode",
        "method",
        "sessionId",
        "requestId",
        "proof",
    ]);
    header(c, "credential");
    mode(c.mode);
    const validator = methodValidation(c.method);
    text(c.sessionId);
    text(c.requestId);
    validator.credential(c);
    if (
        request &&
        (c.mode !== request.mode ||
            c.sessionId !== request.sessionId ||
            c.requestId !== request.requestId ||
            c.method !== request.method)
    )
        return invalid();
    return structuredClone(c) as unknown as Credential;
}

export function assertReceiptMatchesRequest(
    receipt: NonNullable<PaymentSession["receipt"]>,
    request: Request
): void {
    methodValidation(request.method).matchReceipt(receipt, request);
}
export function assertRequestLinksSafe(request: Request, token: string): void {
    const urls = [request.links.credentials.href];
    for (const url of urls) {
        assertNoSecret(url, token);
        for (const value of methodValidation(request.method).privateValues(request))
            assertNoSecret(url, value);
    }
}
