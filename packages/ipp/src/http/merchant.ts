import { apiUrl, assertNoSecret, bearer, idempotencyKey } from "../core/values";
import { invalid } from "../core/errors";
import { sendIpp, type HttpOptions } from "./transport";
import { parseCheckout, parseCheckoutInput, parsePaymentSession } from "../core/validation";
import type { Checkout, CheckoutInput, PaymentSession } from "../core/types";

export interface MerchantClientOptions extends HttpOptions {
    createUrl: string;
    token: string;
}
/** The merchant chooses its creation URL and supplies its own scoped Bearer credential. */
export class IppMerchantClient {
    readonly #url: string;
    readonly #token: string;
    readonly #http: HttpOptions;
    constructor(options: MerchantClientOptions) {
        this.#url = apiUrl(options.createUrl);
        this.#token = bearer(options.token);
        this.#http = {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.requestTimeoutMs !== undefined
                ? { requestTimeoutMs: options.requestTimeoutMs }
                : {}),
        };
    }
    async createCheckout(
        value: CheckoutInput | unknown,
        key: string,
        signal?: AbortSignal
    ): Promise<Checkout> {
        const input = parseCheckoutInput(value);
        const result = await sendIpp(
            this.#http,
            this.#url,
            this.#token,
            "POST",
            input,
            idempotencyKey(key),
            signal,
            [200, 201]
        );
        const c = parseCheckout(result.value);
        if (c.expiresAt !== input.expiresAt) return invalid();
        return c;
    }
}
export function createCheckoutUrl(
    sessionUrl: string,
    token: string,
    checkoutPage = "https://dapp.invisipay.fi/checkout"
): string {
    const base = apiUrl(checkoutPage);
    assertNoSecret(base, bearer(token));
    assertNoSecret(apiUrl(sessionUrl), bearer(token));
    return `${base}#${new URLSearchParams({ sessionUrl: apiUrl(sessionUrl), token: bearer(token) })}`;
}
/** Serializes a previously created session; no order creation or redemption side effects. */
export function paymentRequiredResponse(
    value: PaymentSession | unknown,
    entry: Checkout | unknown
): Response {
    const checkout = parseCheckout(entry);
    const s = parsePaymentSession(value, new URL(checkout.sessionUrl).origin);
    if (s.expiresAt !== checkout.expiresAt || s.status === "succeeded" || s.status === "failed")
        return invalid();
    return new Response(JSON.stringify(s), {
        status: 402,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            Link: `<${checkout.sessionUrl}>; rel="ipp-session", <${checkout.checkoutUrl}>; rel="ipp-checkout"`,
        },
    });
}
