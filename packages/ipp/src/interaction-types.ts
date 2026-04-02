// === 支付方交互 ===

/** Paymaster service configuration for EIP-4337 gasless payments */
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
  reason?: string | undefined
}

export interface AuthorizeRequest {
  identityCommitment: string
  amount: string
  expiry: string
}

export interface AuthorizeResponse {
  status: "accepted" | "rejected"
  nonce?: string | undefined
  creditCommitment?: string | undefined
  nullifierKeyHash?: string | undefined
  reason?: string | undefined
}

export interface StatusResponse {
  status: "unknown" | "accepted" | "submitted" | "confirmed" | "settled"
  txHash?: string | undefined
  amount?: string | undefined
}

export interface NotifyRequest {
  paymentCommitment: string
  txHash: string
  network: string
}

export interface NotifyResponse {
  received: boolean
}

// === 收款方操作 ===

export interface WithdrawRequest {
  identityCommitment: string
  tokenAddress: string
  treeId: string
  paymentCommitments: string[]
}

export interface WithdrawResponse {
  status: "accepted" | "rejected"
  witness?: {
    merkleRoot: string
    nullifiers: string[]
    totalAmount: string
    receivingAddress: string
    merkleProofs: unknown[]
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

export interface RelayResponse {
  status: "queued" | "submitted" | "rejected"
  relayId?: string | undefined
  txHash?: string | undefined
  errorCode?: RelayErrorCode | undefined
  reason?: string | undefined
}

export interface RelayProveResponse {
  status: "queued" | "completed" | "rejected"
  relayId?: string | undefined
  proof?: string | undefined
  calldata?: string | undefined
  errorCode?: RelayErrorCode | undefined
  reason?: string | undefined
}

export type RelayErrorCode =
  | "invalid_signature"
  | "invalid_calldata"
  | "invalid_witness"
  | "unsupported_circuit"
  | "unsupported_operation"
  | "insufficient_gas"
  | "queue_full"
  | "rate_limited"
  | "internal"

export interface RelayStatusResponse {
  status: "queued" | "proving" | "completed" | "submitted" | "confirmed" | "failed"
  proof?: string | undefined
  calldata?: string | undefined
  txHash?: string | undefined
  errorCode?: RelayErrorCode | undefined
  reason?: string | undefined
}

// === 错误 ===

export interface ErrorResponse {
  error: string
  message?: string | undefined
}
