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

  if (typeof p.treeId !== "string" || !p.treeId) {
    throw new Error("Invalid IPPRequest: treeId is required")
  }

  if (!Array.isArray(p.paymentTypes) || p.paymentTypes.length === 0) {
    throw new Error("Invalid IPPRequest: paymentTypes must be a non-empty array")
  }

  for (const pt of p.paymentTypes) {
    if (!VALID_PAYMENT_TYPES.includes(pt)) {
      throw new Error(
        `Invalid IPPRequest: paymentTypes contains invalid type "${pt}"`,
      )
    }
  }

  const hasNonce = p.nonce !== undefined
  const hasPC = p.paymentCommitment !== undefined
  if (hasNonce !== hasPC) {
    throw new Error(
      "Invalid IPPRequest: nonce and paymentCommitment must both be present or both absent",
    )
  }

  if (!hasNonce && !p.endpoint) {
    throw new Error(
      "Invalid IPPRequest: endpoint is required when nonce is not provided (mode 1b/2 requires propose)",
    )
  }
}
