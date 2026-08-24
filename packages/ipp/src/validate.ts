import type { IPPRequest, IPPVoucher, PaymentType } from "./types"

const VALID_PAYMENT_TYPES: PaymentType[] = ["open", "blind", "credit"]
const CAIP2_REGEX = /^eip155:\d+$/

export function validateIPPRequest(request: IPPRequest): void {
  if (typeof request.v !== "number" || request.v < 1) {
    throw new Error("Invalid IPPRequest: v must be a positive number")
  }

  if (!CAIP2_REGEX.test(request.network)) {
    throw new Error(
      `Invalid IPPRequest: network must be CAIP-2 format (eip155:<chainId>), got "${request.network}"`,
    )
  }

  if (!request.payload || typeof request.payload !== "object") {
    throw new Error("Invalid IPPRequest: payload is required")
  }

  const p = request.payload

  if (typeof p.identityCommitment !== "string" || !p.identityCommitment) {
    throw new Error("Invalid IPPRequest: identityCommitment is required")
  }

  if (typeof p.tokenAddress !== "string" || !p.tokenAddress) {
    throw new Error("Invalid IPPRequest: tokenAddress is required")
  }

  if (typeof p.operator !== "string" || !p.operator) {
    throw new Error("Invalid IPPRequest: operator is required")
  }

  if (!Array.isArray(p.paymentTypes) || p.paymentTypes.length === 0) {
    throw new Error("Invalid IPPRequest: paymentTypes must be a non-empty array")
  }

  for (const pt of p.paymentTypes) {
    if (!VALID_PAYMENT_TYPES.includes(pt)) {
      throw new Error(`Invalid IPPRequest: paymentTypes contains invalid type "${pt}"`)
    }
  }

  // A single/multi request delivers its payment materials via propose, so it must
  // carry an endpoint. The rule fires only for an explicit single/multi — a credit
  // code's one-time semantics ride on credit_id, not mode. Amount-per-mode and
  // credit⇒creditId are the encoder's tightening rules, not the SDK baseline.
  if (p.mode === "single" || p.mode === "multi") {
    if (typeof p.endpoint !== "string" || !p.endpoint) {
      throw new Error(
        "Invalid IPPRequest: endpoint is required when mode is 'single' or 'multi' (payment materials are delivered via propose)",
      )
    }
  }
}

export function validateIPPVoucher(voucher: IPPVoucher): void {
  if (typeof voucher.v !== "number" || voucher.v < 1) {
    throw new Error("Invalid IPPVoucher: v must be a positive number")
  }

  if (!CAIP2_REGEX.test(voucher.network)) {
    throw new Error(
      `Invalid IPPVoucher: network must be CAIP-2 format (eip155:<chainId>), got "${voucher.network}"`,
    )
  }

  if (voucher.type !== "voucher") {
    throw new Error(`Invalid IPPVoucher: type must be "voucher", got "${voucher.type}"`)
  }

  if (!voucher.payload || typeof voucher.payload !== "object") {
    throw new Error("Invalid IPPVoucher: payload is required")
  }

  const p = voucher.payload

  if (typeof p.receivingAddress !== "string" || !p.receivingAddress) {
    throw new Error("Invalid IPPVoucher: receivingAddress is required")
  }

  if (typeof p.paymentCommitment !== "string" || !p.paymentCommitment) {
    throw new Error("Invalid IPPVoucher: paymentCommitment is required")
  }

  if (typeof p.tokenAddress !== "string" || !p.tokenAddress) {
    throw new Error("Invalid IPPVoucher: tokenAddress is required")
  }

  if (typeof p.operator !== "string" || !p.operator) {
    throw new Error("Invalid IPPVoucher: operator is required")
  }

  if (typeof p.amount !== "string" || !p.amount) {
    throw new Error("Invalid IPPVoucher: amount is required")
  }

  if (typeof p.nonce !== "string" || !p.nonce) {
    throw new Error("Invalid IPPVoucher: nonce is required")
  }

  if (typeof p.nullifierKey !== "string" || !p.nullifierKey) {
    throw new Error("Invalid IPPVoucher: nullifierKey is required")
  }

  if (typeof p.treeId !== "string" || !p.treeId) {
    throw new Error("Invalid IPPVoucher: treeId is required")
  }

  if (typeof p.endpoint !== "string" || !p.endpoint) {
    throw new Error("Invalid IPPVoucher: endpoint is required")
  }

  try {
    new URL(p.endpoint)
  } catch {
    throw new Error(`Invalid IPPVoucher: endpoint must be a valid URL, got "${p.endpoint}"`)
  }
}
