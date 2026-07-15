import type { RejectCode, RelayErrorCode } from "./codes"

export type { RelayErrorCode } from "./codes"

// === 支付方交互 ===

/**
 * Paymaster service configuration for EIP-4337 gasless payments.
 * NOTE: Identical type exists in @invisi-labs/payer (gasEstimates.ts).
 * Duplicated to avoid circular dependency.
 */
export interface PaymasterConfig {
  /** Paymaster service RPC URL */
  url: string
  /** Sponsorship policy ID (required by some providers) */
  policyId?: string
  /** Extension fields (required by some providers) */
  context?: Record<string, unknown>
}

export interface InfoRequest {
  identityCommitment: string
}

export interface InfoResponse {
  merchantName?: string | undefined
  description?: string | undefined
  amount?: string | undefined
  currency?: string | undefined
  expiresAt?: string | undefined
  /** Merchant's gas sponsorship config for EIP-4337 (optional) */
  paymaster?: PaymasterConfig | undefined
}

export interface ProposeRequest {
  identityCommitment: string
  amount: string
}

export interface ProposeResponse {
  status: "accepted" | "rejected"
  nonce?: string | undefined
  paymentCommitment?: string | undefined
  /** Target Payment Tree id (wire `tree_id`); set when accepted. */
  treeId?: string | undefined
  /** Set when status="rejected" (Channel ② — true business rejection). Wire `reject_code`. */
  rejectCode?: RejectCode | undefined
  reason?: string | undefined
}

export interface AuthorizeRequest {
  identityCommitment: string   // receiver
  amount: string
  expiry: string
  /** Required in credit mode; payer-derived locally (nonce-independent, non-custodial). Omitted in plain 6.2 usage. */
  payerCommitment?: string | undefined
  /** Links this authorization to a subscription; the server persists it and forwards it to the subscription side on deposit-confirmed. Omitted for a standalone authorization. */
  subscriptionId?: string | undefined
}

export interface AuthorizeResponse {
  status: "accepted" | "rejected"
  nonce?: string | undefined
  /** Target Payment Tree id (wire `tree_id`); set when accepted. */
  treeId?: string | undefined
  creditCommitment?: string | undefined
  /** Server-folded hash, echoed for cross-checking / debugging. Wire `nullifier_key_hash`. */
  nullifierKeyHash?: string | undefined
  /** Server-derived shared secret (0x bytes32 hex), downlinked over TLS. Returned when status="accepted"; the caller MUST verify it via two-step check before use. Wire `credit_nullifier_key`. */
  creditNullifierKey?: string | undefined
  /** Set when status="rejected" (Channel ② — true business rejection). Wire `reject_code`. */
  rejectCode?: RejectCode | undefined
  reason?: string | undefined
}

export interface StatusResponse {
  status: "unknown" | "accepted" | "cancelled" | "submitted" | "confirmed" | "settled"
  txHash?: string | undefined
  amount?: string | undefined
}

export interface NotifyRequest {
  commitment: string
  action: "submitted" | "cancelled"
  txHash?: string | undefined
  network?: string | undefined
}

export interface NotifyResponse {
  status: "received" | "not_found" | "already_onchain"
}

// === 收款方操作 ===

export interface WithdrawRequest {
  /** advisory: server locates leaves by paymentCommitments and ignores this; mode-3 vouchers omit it */
  identityCommitment?: string | undefined
  tokenAddress: string
  treeId: string
  paymentCommitments: string[]
}

export interface WithdrawResponse {
  status: "accepted" | "rejected"
  /** server-authoritative merkle data only; withdraw is non-custodial (server has no nullifierKey). nullifiers + receivingAddress are client-supplied circuit inputs, not returned here */
  witness?: {
    merkleRoot: string
    merkleProofs: unknown[]
    totalAmount: string
  } | undefined
  circuit?: string | undefined
  reason?: string | undefined
}

export interface CreditDrawRequest {
  identityCommitment: string
  tokenAddress: string
  treeId: string
  creditCommitments: string[]
  amounts: string[]
}

export interface CreditDrawResponse {
  status: "accepted" | "rejected"
  witness?: {
    merkleRoot: string
    nullifiers: string[]
    totalAmount: string
    receivingAddress: string
    remainderCommitments: string[]
    expiry: string
    merkleProofs: unknown[]
  } | undefined
  circuit?: string | undefined
  /** Set when status="rejected" (Channel ② — true business rejection). Wire `reject_code`. */
  rejectCode?: RejectCode | undefined
  reason?: string | undefined
}

export interface CreditReclaimRequest {
  creditCommitment: string
  tokenAddress: string
  treeId: string
}

export interface CreditReclaimResponse {
  status: "accepted" | "rejected"
  witness?: {
    merkleRoot: string
    nullifier: string
    amount: string
    receivingAddress: string
    expiry: string
    merkleProof: unknown
  } | undefined
  circuit?: string | undefined
  /** Set when status="rejected" (Channel ② — true business rejection). Wire `reject_code`. */
  rejectCode?: RejectCode | undefined
  reason?: string | undefined
}

export interface CreditStatusResponse {
  status: "active" | "expired" | "reclaimed"
  originalAmount: string
  drawnAmount: string
  remainderAmount: string
  expiry: string
  draws: {
    amount: string
    timestamp: string
    txHash: string
  }[]
}

// === 交易中继 ===

export type RelayRequest =
  | RelaySignatureRequest
  | RelayCalldataRequest
  | RelayWitnessRequest
  | RelayProveRequest

export type RelayOperation =
  | "pay-open"
  | "pay-blind"
  | "deposit-credit"
  | "withdraw"
  | "credit-draw"
  | "credit-reclaim"

export type RelayWitnessOperation = "withdraw" | "credit-draw" | "credit-reclaim"

export interface RelaySignatureRequest {
  mode: "signature"
  operation: RelayOperation
  network: string
  signature: string
  paymentCommitment: string
  identityCommitment: string
  tokenAddress: string
  amount: string
  nonce: string
  treeId: string
}

export interface RelayCalldataRequest {
  mode: "calldata"
  operation: RelayOperation
  network: string
  calldata: string
}

export interface RelayWitnessRequest {
  mode: "witness"
  operation: RelayWitnessOperation
  network: string
  witness: unknown
  circuit: string
}

export interface RelayProveRequest {
  mode: "prove"
  operation: RelayWitnessOperation
  witness: unknown
  circuit: string
}

// Synchronous Relay() response. Per the protocol contract a sync failure goes
// through the Stripe envelope (Channel ①), so the async `errorCode` is NOT
// carried here — it lives on RelayStatusResponse (Channel ③). Field omitted.
export interface RelayResponse {
  status: "queued" | "submitted" | "rejected"
  relayId?: string | undefined
  txHash?: string | undefined
  reason?: string | undefined
}

export interface RelayProveResponse {
  status: "queued" | "completed" | "rejected"
  relayId?: string | undefined
  proof?: string | undefined
  calldata?: string | undefined
  reason?: string | undefined
}

// Channel ③ — async relay result. `errorCode` is read here (status="failed");
// the open-string RelayErrorCode (see codes.ts §E3) lets unknown server codes
// flow through without breaking the SDK.
export interface RelayStatusResponse {
  status: "queued" | "proving" | "completed" | "submitted" | "confirmed" | "failed"
  proof?: string | undefined
  calldata?: string | undefined
  txHash?: string | undefined
  errorCode?: RelayErrorCode | undefined
  reason?: string | undefined
}
