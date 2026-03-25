import { encodeFunctionData, type Address, type Hex } from "viem"
import {
  deriveNullifierKey,
  computeIdentityCommitment,
  computeRefundLink,
} from "@invisi/core"
import { invisiPoolAbi } from "@invisi/contracts"

// BN254 field modulus
const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n

// ---------- Types ----------

export interface OriginalPaymentRecord {
  originalCommitment: bigint
  payerAddress: Address
  tokenAddress: Address
  treeId: bigint
  amount: bigint
}

export interface RefundParams {
  /** to find originalCommitment and payerAddress */
  originalInvoiceId: string
  /** to derive refundNullifierKey */
  refundId: string
  /** amount to refund */
  refundAmount: bigint
  /** optional override, default from original payment event; if provided, validate against on-chain record */
  payerAddress?: Address
  /** use payShielded for privacy refund, default false */
  useShielded?: boolean
}

export interface RefundResult {
  /** merchant must persist for audit */
  refundNonce: bigint
  /** on-chain anchor (0x-prefixed hex) */
  refundLink: Hex
  /** payPublic/payShielded tx hash */
  payTxHash: Hex
  /** withdraw tx hash */
  withdrawTxHash: Hex
  /** actual refund amount */
  refundAmount: bigint
}

export interface ResumeRefundParams {
  /** to re-derive refundNullifierKey */
  refundId: string
  /** the nonce used in the original refund pay tx */
  refundNonce: bigint
  /** original payment record */
  originalPayment: OriginalPaymentRecord
  /** chain id */
  chainId: bigint
  /** payer address to refund to */
  payerAddress: Address
  /** token address */
  tokenAddress: Address
  /** refund amount */
  refundAmount: bigint
  /** tree id */
  treeId: bigint
}

/**
 * Lookup function type — provided by the merchant's invoice system.
 * Returns the original payment record for a given invoiceId.
 */
export type LookupOriginalPayment = (
  invoiceId: string
) => Promise<OriginalPaymentRecord>

/**
 * Wallet send function type — sends a transaction and returns the tx hash.
 */
export type SendTransaction = (calldata: {
  data: Hex
  to: Address
  value?: bigint
}) => Promise<Hex>

/**
 * Waits for a pay tx to confirm and returns the leafIndex from the event.
 */
export type WaitForPayConfirmation = (txHash: Hex) => Promise<{ leafIndex: number }>

/**
 * Generates a ZK proof for withdrawal and submits the withdraw tx.
 * Returns the withdraw tx hash.
 */
export type SubmitWithdraw = (params: {
  nullifierKey: bigint
  payerAddress: Address
  tokenAddress: Address
  amount: bigint
  nonce: bigint
  treeId: bigint
  leafIndex: number
  chainId: bigint
}) => Promise<Hex>

export interface RefundDependencies {
  masterKey: bigint
  chainId: bigint
  poolAddress: Address
  lookupOriginalPayment: LookupOriginalPayment
  sendTransaction: SendTransaction
  waitForPayConfirmation: WaitForPayConfirmation
  submitWithdraw: SubmitWithdraw
}

// ---------- Helpers ----------

/**
 * Convert a string ID to a bigint field element.
 * Encodes the string as UTF-8 bytes, interprets as big-endian integer, reduces mod FIELD_MODULUS.
 */
export function stringIdToBigInt(id: string): bigint {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(id)
  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result % FIELD_MODULUS
}

function generateRefundNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt(
    "0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("")
  )
  return raw % FIELD_MODULUS
}

function toHex(value: bigint): Hex {
  return ("0x" + value.toString(16).padStart(64, "0")) as Hex
}

// ---------- buildRefundPayPublicCalldata ----------

export interface BuildRefundPayPublicCalldataParams {
  identityCommitment: Hex
  tokenAddress: Address
  refundAmount: bigint
  nonce: bigint
  treeId: bigint
  refundLink: Hex
}

export async function buildRefundPayPublicCalldata(
  params: BuildRefundPayPublicCalldataParams
): Promise<{ data: Hex }> {
  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "payPublic",
    args: [
      params.identityCommitment,
      { addr: params.tokenAddress, amount: params.refundAmount },
      toHex(params.nonce),
      params.treeId,
      params.refundLink,
    ],
  })

  return { data }
}

// ---------- refund ----------

export async function refund(
  params: RefundParams,
  deps: RefundDependencies
): Promise<RefundResult> {
  // 1. Look up original payment
  const original = await deps.lookupOriginalPayment(params.originalInvoiceId)

  // 2. Validate payerAddress if provided
  const payerAddress = params.payerAddress ?? original.payerAddress
  if (
    params.payerAddress &&
    params.payerAddress.toLowerCase() !== original.payerAddress.toLowerCase()
  ) {
    throw new Error(
      `payerAddress mismatch: provided ${params.payerAddress}, on-chain ${original.payerAddress}`
    )
  }

  // 3. Validate refund amount
  if (params.refundAmount <= 0n) {
    throw new Error("refundAmount must be positive")
  }
  if (params.refundAmount > original.amount) {
    throw new Error(
      `refundAmount ${params.refundAmount} exceeds original payment amount ${original.amount}`
    )
  }

  // 4. Derive refund keys
  const refundNullifierKey = await deriveNullifierKey(
    deps.masterKey,
    stringIdToBigInt(params.refundId)
  )
  const identityCommitment = await computeIdentityCommitment(
    refundNullifierKey,
    BigInt(payerAddress)
  )

  // 5. Generate refund nonce and compute refundLink
  const refundNonce = generateRefundNonce()
  const refundLink = await computeRefundLink(
    original.originalCommitment,
    refundNonce
  )

  // 6. Build and send pay tx
  const { data } = await buildRefundPayPublicCalldata({
    identityCommitment,
    tokenAddress: original.tokenAddress,
    refundAmount: params.refundAmount,
    nonce: refundNonce,
    treeId: original.treeId,
    refundLink,
  })

  const payTxHash = await deps.sendTransaction({
    data,
    to: deps.poolAddress,
  })

  // 7. Wait for confirmation
  const { leafIndex } = await deps.waitForPayConfirmation(payTxHash)

  // 8. Generate ZK proof and withdraw to payer
  const withdrawTxHash = await deps.submitWithdraw({
    nullifierKey: refundNullifierKey,
    payerAddress,
    tokenAddress: original.tokenAddress,
    amount: params.refundAmount,
    nonce: refundNonce,
    treeId: original.treeId,
    leafIndex,
    chainId: deps.chainId,
  })

  return {
    refundNonce,
    refundLink,
    payTxHash,
    withdrawTxHash,
    refundAmount: params.refundAmount,
  }
}

// ---------- resumeRefund ----------

export async function resumeRefund(
  params: ResumeRefundParams,
  deps: Pick<RefundDependencies, "masterKey" | "chainId" | "submitWithdraw"> & {
    leafIndex: number
  }
): Promise<RefundResult> {
  // 1. Re-derive refundNullifierKey
  const refundNullifierKey = await deriveNullifierKey(
    deps.masterKey,
    stringIdToBigInt(params.refundId)
  )

  // 2. Compute refundLink for the result
  const refundLink = await computeRefundLink(
    params.originalPayment.originalCommitment,
    params.refundNonce
  )

  // 3. Submit withdraw
  const withdrawTxHash = await deps.submitWithdraw({
    nullifierKey: refundNullifierKey,
    payerAddress: params.payerAddress,
    tokenAddress: params.tokenAddress,
    amount: params.refundAmount,
    nonce: params.refundNonce,
    treeId: params.treeId,
    leafIndex: deps.leafIndex,
    chainId: deps.chainId,
  })

  return {
    refundNonce: params.refundNonce,
    refundLink,
    payTxHash: "0x" as Hex, // already confirmed in previous attempt
    withdrawTxHash,
    refundAmount: params.refundAmount,
  }
}
