import type { IPPRequest, PaymentType } from "./types"

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

  // SPEC-029 baseline: scan-distributed requests carry mode ∈ {single,multi} and
  // deliver payment materials via propose, so they MUST carry an endpoint. The rule
  // fires only for an explicit single/multi (a credit code's one-time semantics ride
  // credit_id, not mode; amount-per-mode / credit⇒creditId are encoding-tightening
  // rules the encoder guarantees, not SDK baseline).
  if (p.mode === "single" || p.mode === "multi") {
    if (typeof p.endpoint !== "string" || !p.endpoint) {
      throw new Error(
        "Invalid IPPRequest: endpoint is required when mode is 'single' or 'multi' (payment materials are delivered via propose)",
      )
    }
  }
}
