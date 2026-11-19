import type { PaymentRequest, CreditRequest, Request } from "../core/types";
export const origin = "https://connect.invisipay.fi";
export const sessionUrl = `${origin}/custom/session?route=one`;
export const token = "EXAMPLE_SESSION_TOKEN";
export const address = "0x1111111111111111111111111111111111111111";
export const protocolAddress = "0x3333333333333333333333333333333333333333";
export const hash = `0x${"01".repeat(32)}`;
export const spender =
    "0iqY352Euf40X77QFrG4NcN27DaUqJX3t8QfUMUEn7l8wtHtz45p3FTN58pvRs9XlumvKUu2Xet8EgZkCklQTeShnK47w8gFh6cNvcL2u22ddW6QTqfV5Lmn69330k27sES28pJeqj";
export const terms = {
    spender,
    availableCredit: "1000000000",
    unlimited: false,
    singleLimit: "10000000",
    dailyLimit: "50000000",
    monthlyLimit: "300000000",
    expiresAt: "2027-11-17T08:00:00Z",
};
export function session(mode: "payment" | "credit" = "payment") {
    return {
        ippVersion: 1,
        type: "payment_session",
        mode,
        sessionId: "ses_test",
        status: "open",
        merchant: { name: "Example Store" },
        description: "A report",
        options: [
            {
                id: "base_usdc",
                method: "invisi",
                network: "eip155:8453",
                asset: { address, symbol: "USDC", decimals: 6 },
                ...(mode === "payment" ? { amount: "10000000" } : { credit: { ...terms } }),
            },
        ],
        activeRequestId: null,
        createdAt: "2026-11-17T08:00:00Z",
        expiresAt: "2026-11-17T08:05:00Z",
        links: {
            confirm: { href: `${origin}/custom/confirm`, method: "POST" },
            request: null,
        },
        failureReason: null,
        receipt: null,
        evidenceStatus: null,
        exceptionSummary: { count: 0, unresolvedCount: 0 },
    };
}
export function request(mode?: "payment"): PaymentRequest;
export function request(mode: "credit"): CreditRequest;
export function request(mode: "payment" | "credit"): Request;
export function request(mode: "payment" | "credit" = "payment"): unknown {
    return {
        ippVersion: 1,
        type: mode === "payment" ? "payment_request" : "credit_request",
        mode,
        method: "invisi",
        sessionId: "ses_test",
        requestId: "req_test",
        optionId: "base_usdc",
        status: "requires_action",
        ...(mode === "payment"
            ? {
                  payment: {
                      network: "eip155:8453",
                      protocolAddress,
                      tokenAddress: address,
                      amount: "10000000",
                      recipient: { type: "identity", identity: hash },
                  },
              }
            : {
                  credit: {
                      operation: "create",
                      network: "eip155:8453",
                      protocolAddress,
                      tokenAddress: address,
                      ...terms,
                      creditSharedKey: hash,
                  },
              }),
        createdAt: "2026-11-17T08:02:00Z",
        expiresAt: "2026-11-17T08:20:00Z",
        links: { credentials: { href: `${origin}/custom/hints`, method: "POST" } },
        failureReason: null,
    };
}
export function checkout() {
    return {
        ippVersion: 1,
        type: "checkout",
        sessionUrl,
        checkoutUrl: `https://dapp.invisipay.fi/checkout#${new URLSearchParams({ sessionUrl, token })}`,
        expiresAt: "2026-11-17T08:05:00Z",
    };
}
export function receipt() {
    return {
        network: "eip155:8453",
        protocolAddress,
        transactionHash: hash,
        commitment: hash,
        blockNumber: "38000000",
        blockHash: hash,
        completedAt: "2026-11-17T08:03:00Z",
    };
}
