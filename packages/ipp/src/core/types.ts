import type { Option, PaymentReceipt, CreditReceipt } from "../methods/invisi/types";
export type {
    Asset,
    CreditTerms,
    PaymentOption,
    CreditOption,
    Option,
    PaymentReceipt,
    CreditReceipt,
    PaymentRequest,
    CreditRequest,
    Request,
    Credential,
} from "../methods/invisi/types";

/** IPP messages are independent of the chain SDK's ordinary Note PaymentRequest. */
export type Mode = "payment" | "credit";
export type RequestStatus = "requires_action" | "processing" | "succeeded" | "failed";
export type SessionStatus = "open" | RequestStatus;
export type FailureReason = "expired" | "closed" | null;
export type EvidenceStatus = "confirmed" | "reconciling" | "disputed" | null;
export interface Link<M extends "GET" | "POST" = "GET" | "POST"> {
    href: string;
    method: M;
}
export interface PaymentSession {
    ippVersion: 1;
    type: "payment_session";
    mode: Mode;
    sessionId: string;
    status: SessionStatus;
    merchant: { name: string };
    description?: string;
    options: Option[];
    activeRequestId: string | null;
    createdAt: string;
    expiresAt: string;
    links: { confirm: Link<"POST">; request: Link<"GET"> | null };
    failureReason: FailureReason;
    receipt: PaymentReceipt | CreditReceipt | null;
    evidenceStatus: EvidenceStatus;
    exceptionSummary: { count: number; unresolvedCount: number };
}
export interface Checkout {
    ippVersion: 1;
    type: "checkout";
    sessionUrl: string;
    checkoutUrl: string;
    expiresAt: string;
}
export interface CheckoutInput {
    ippVersion: 1;
    mode: Mode;
    description?: string;
    options: Option[];
    expiresAt: string;
}
export interface CredentialAcknowledgement {
    ippVersion: 1;
    type: "credential_acknowledgement";
    sessionId: string;
    requestId: string;
    status: "accepted";
}
export interface ErrorMessage {
    ippVersion: 1;
    type: "error";
    error: { code: string; message: string; retryable: boolean };
}
