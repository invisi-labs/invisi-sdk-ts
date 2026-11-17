import { apiUrl, assertNoSecret, bearer, idempotencyKey, object } from "../core/values";
import { methodValidation } from "../core/methods";
import { readIppResponse } from "../core/json";
import { IppError, invalid } from "../core/errors";
import {
    aborted,
    delay,
    duration,
    sendIpp,
    stable,
    retryAfter,
    type HttpOptions,
} from "./transport";
import {
    assertReceiptMatchesRequest,
    assertRequestLinksSafe,
    assertRequestMatchesSession,
    parseCheckout,
    parseCheckoutEntry,
    parseCredential,
    parsePaymentRequest,
    parsePaymentSession,
} from "../core/validation";
import type {
    Checkout,
    Credential,
    CredentialAcknowledgement,
    PaymentSession,
    Request,
} from "../core/types";

export interface IppClientOptions extends HttpOptions {
    sessionUrl: string;
    token: string;
}
export interface WaitOptions {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** A session-bound HTTP client. It never signs, broadcasts, pays or redeems evidence. */
export class IppClient {
    readonly #url: string;
    readonly #token: string;
    readonly #origin: string;
    readonly #http: HttpOptions;
    #session: PaymentSession | undefined;
    #request: Request | undefined;
    #requestUrl: string | undefined;
    #option: string | undefined;
    #retryAfterMs: number | undefined;
    constructor(options: IppClientOptions) {
        this.#url = apiUrl(options.sessionUrl);
        this.#origin = new URL(this.#url).origin;
        this.#token = bearer(options.token);
        assertNoSecret(this.#url, this.#token);
        this.#http = {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            requestTimeoutMs: duration(options.requestTimeoutMs ?? 15000),
        };
    }
    static fromCheckout(value: Checkout | unknown, options: HttpOptions = {}): IppClient {
        const c = parseCheckout(value);
        const entry = parseCheckoutEntry(c.checkoutUrl);
        return new IppClient({ ...entry, ...options });
    }
    static async fromPaymentRequired(
        response: Response,
        options: HttpOptions = {}
    ): Promise<IppClient> {
        if (
            response.status !== 402 ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")
        )
            return invalid();
        const links = response.headers.get("Link") ?? "";
        const entries = [...links.matchAll(/<([^<>]+)>\s*;\s*rel="ipp-(session|checkout)"/g)];
        const sessions = entries.filter((e) => e[2] === "session");
        const checkouts = entries.filter((e) => e[2] === "checkout");
        if (sessions.length !== 1 || checkouts.length !== 1) return invalid();
        const sessionUrl = apiUrl(sessions[0]![1]);
        const entry = parseCheckoutEntry(checkouts[0]![1]!);
        if (entry.sessionUrl !== sessionUrl) return invalid();
        const client = new IppClient({ ...entry, ...options });
        client.#session = parsePaymentSession(
            await readIppResponse(response),
            new URL(sessionUrl).origin
        );
        client.#assertSessionLinks(client.#session);
        if (client.#session.links.request) client.#requestUrl = client.#session.links.request.href;
        return client;
    }
    async readSession(signal?: AbortSignal): Promise<PaymentSession> {
        const { value, response } = await sendIpp(
            this.#http,
            this.#url,
            this.#token,
            "GET",
            undefined,
            undefined,
            signal,
            [200]
        );
        const s = parsePaymentSession(value, this.#origin);
        this.#assertSessionLinks(s);
        this.#retryAfterMs = retryAfter(response.headers.get("Retry-After"));
        const old = this.#session;
        if (old) {
            for (const key of [
                "sessionId",
                "mode",
                "createdAt",
                "expiresAt",
                "merchant",
                "description",
                "options",
            ] as const)
                if (stable(old[key]) !== stable(s[key])) return invalid();
            if (old.activeRequestId && old.activeRequestId !== s.activeRequestId) return invalid();
            if (
                ["succeeded", "failed"].includes(old.status) &&
                (old.status !== s.status || old.failureReason !== s.failureReason)
            )
                return invalid();
            if (old.receipt && stable(old.receipt) !== stable(s.receipt)) return invalid();
        }
        if (this.#request) {
            assertRequestMatchesSession(this.#request, s);
            if (s.activeRequestId !== this.#request.requestId) return invalid();
            if (s.receipt) {
                assertReceiptMatchesRequest(s.receipt, this.#request);
            }
        }
        this.#session = s;
        if (s.links.request) this.#requestUrl = s.links.request.href;
        return structuredClone(s);
    }
    #assertUrl(url: string, request = this.#request): void {
        assertNoSecret(url, this.#token);
        if (request)
            for (const secret of methodValidation(request.method).privateValues(request))
                assertNoSecret(url, secret);
    }
    #assertSessionLinks(session: PaymentSession, request = this.#request): void {
        this.#assertUrl(session.links.confirm.href, request);
        if (session.links.request) this.#assertUrl(session.links.request.href, request);
    }
    #accept(value: unknown): Request {
        const r = parsePaymentRequest(value, this.#origin);
        assertRequestLinksSafe(r, this.#token);
        if (!this.#session) return invalid();
        assertRequestMatchesSession(r, this.#session);
        this.#assertSessionLinks(this.#session, r);
        this.#assertUrl(this.#url, r);
        if (this.#requestUrl) this.#assertUrl(this.#requestUrl, r);
        if (this.#session.receipt) assertReceiptMatchesRequest(this.#session.receipt, r);
        if (this.#option && r.optionId !== this.#option) return invalid();
        if (this.#request) {
            const frozen = (v: Request) => {
                const { status: _s, failureReason: _f, links: _l, ...terms } = v;
                return terms;
            };
            if (stable(frozen(r)) !== stable(frozen(this.#request))) return invalid();
            if (
                ["succeeded", "failed"].includes(this.#request.status) &&
                (r.status !== this.#request.status ||
                    r.failureReason !== this.#request.failureReason)
            )
                return invalid();
        }
        this.#request = r;
        this.#option = r.optionId;
        return structuredClone(r);
    }
    async confirm(optionId: string, key: string, signal?: AbortSignal): Promise<Request> {
        idempotencyKey(key);
        if (!this.#session) await this.readSession(signal);
        const s = this.#session!;
        if (
            !s.options.some((o) => o.id === optionId) ||
            (this.#option && optionId !== this.#option)
        )
            return invalid();
        const { value, response } = await sendIpp(
            this.#http,
            s.links.confirm.href,
            this.#token,
            "POST",
            { optionId },
            key,
            signal,
            [200, 201]
        );
        const location = apiUrl(response.headers.get("Location"), this.#origin);
        if (parsePaymentRequest(value, this.#origin).optionId !== optionId) return invalid();
        const parsed = parsePaymentRequest(value, this.#origin);
        this.#assertUrl(location, parsed);
        const r = this.#accept(parsed);
        this.#requestUrl = location;
        return r;
    }
    async readRequest(signal?: AbortSignal): Promise<Request> {
        if (!this.#session) await this.readSession(signal);
        if (!this.#requestUrl) return invalid();
        const { value } = await sendIpp(
            this.#http,
            this.#requestUrl,
            this.#token,
            "GET",
            undefined,
            undefined,
            signal,
            [200]
        );
        return this.#accept(value);
    }
    async submitCredential(
        value: Credential,
        key?: string,
        signal?: AbortSignal
    ): Promise<CredentialAcknowledgement> {
        if (!this.#request) await this.readRequest(signal);
        const r = this.#request!;
        const c = parseCredential(value, r);
        const result = await sendIpp(
            this.#http,
            r.links.credentials.href,
            this.#token,
            "POST",
            c,
            key === undefined ? undefined : idempotencyKey(key),
            signal,
            [202]
        );
        const ack = object(result.value, [
            "ippVersion",
            "type",
            "sessionId",
            "requestId",
            "status",
        ]);
        if (
            ack.ippVersion !== 1 ||
            ack.type !== "credential_acknowledgement" ||
            ack.status !== "accepted" ||
            ack.sessionId !== r.sessionId ||
            ack.requestId !== r.requestId
        )
            return invalid();
        return structuredClone(ack) as unknown as CredentialAcknowledgement;
    }
    async waitForResult(options: WaitOptions = {}): Promise<PaymentSession> {
        const interval = duration(options.intervalMs ?? 1000),
            timeout = duration(options.timeoutMs ?? 60000);
        const controller = new AbortController();
        const abort = () => controller.abort();
        aborted(options.signal);
        options.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeout);
        const end = Date.now() + timeout;
        try {
            while (Date.now() < end) {
                let wait = interval;
                try {
                    const s = await this.readSession(controller.signal);
                    if (s.status === "succeeded" || s.status === "failed") return s;
                    wait = this.#retryAfterMs ?? interval;
                } catch (error) {
                    if (
                        !(error instanceof IppError) ||
                        !error.retryable ||
                        ![429, 503].includes(error.status ?? 0)
                    )
                        throw error;
                    wait = error.retryAfterMs ?? interval;
                }
                await delay(Math.min(wait, Math.max(1, end - Date.now())), controller.signal);
            }
            throw new IppError(
                "timeout",
                "IPP result is still unknown; query the same session to recover.",
                true
            );
        } catch (error) {
            if (options.signal?.aborted) throw new IppError("aborted", "IPP operation aborted.");
            if (controller.signal.aborted)
                throw new IppError(
                    "timeout",
                    "IPP result is still unknown; query the same session to recover.",
                    true
                );
            throw error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
        }
    }
}
