import type { Address, Hex } from "viem"
import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi-labs/contracts"
import { buildPayOpenCalldata, buildPayBlindCalldata } from "./payer"
import { GAS_ESTIMATES } from "./gasEstimates"
import type { BaseUserOp, PaymasterConfig } from "./gasEstimates"

export interface PayOpenUserOpParams {
  /** Receiver identity commitment */
  identityCommitment: Hex
  /** Token address (for Poseidon hash computation) */
  tokenAddress: Hex
  /** Payment amount */
  amount: bigint
  /** Merkle tree ID */
  treeId: bigint
  /** Refund link (0 = normal payment) */
  refundLink?: bigint
  /** Payment nonce supplied by the caller per the payment mode (mode 1a/1b/2: server/receiver-assigned; mode 3: locally generated). */
  nonce: bigint
  /** InvisiProtocol instance address */
  protocolAddress: Address
  /** Smart Account address */
  sender: Address
  /** Chain ID */
  chainId: bigint
  /** Paymaster config (optional, from IPP InfoResponse) */
  paymaster?: PaymasterConfig
}

export interface PayOpenUserOp extends BaseUserOp {
  /** Payment commitment hash */
  paymentCommitment: Hex
  /** Payment nonce */
  nonce: Hex
}

export async function buildPayOpenUserOp(
  params: PayOpenUserOpParams,
): Promise<PayOpenUserOp> {
  const calldataResult = await buildPayOpenCalldata({
    chainId: params.chainId,
    identityCommitment: params.identityCommitment,
    tokenAddress: params.tokenAddress,
    amount: params.amount,
    treeId: params.treeId,
    refundLink: params.refundLink,
    nonce: params.nonce,
  })

  return {
    to: params.protocolAddress,
    sender: params.sender,
    callData: calldataResult.data, // NOTE: existing builder uses "data" field name
    ...GAS_ESTIMATES.payOpen,
    paymentCommitment: calldataResult.paymentCommitment,
    nonce: calldataResult.nonce,
    ...(params.paymaster ? { paymaster: params.paymaster } : {}),
  }
}

export interface PayBlindUserOpParams {
  /** ZK proof bytes */
  proof: Hex
  /** Payment commitment (pre-computed by caller) */
  paymentCommitment: Hex
  /** Change commitment (pre-computed by caller) */
  changeCommitment: Hex
  /** Total input amount (shielded note value) */
  inputAmount: bigint
  /** Merkle tree ID */
  treeId: bigint
  /** Refund link (0 = normal payment) */
  refundLink?: bigint
  /** InvisiProtocol instance address */
  protocolAddress: Address
  /** Smart Account address */
  sender: Address
  /** Chain ID */
  chainId: bigint
  /** Paymaster config (optional, from IPP InfoResponse) */
  paymaster?: PaymasterConfig
}

export type PayBlindUserOp = BaseUserOp

export async function buildPayBlindUserOp(
  params: PayBlindUserOpParams,
): Promise<PayBlindUserOp> {
  const calldataResult = await buildPayBlindCalldata({
    proof: params.proof,
    paymentCommitment: params.paymentCommitment,
    changeCommitment: params.changeCommitment,
    inputAmount: params.inputAmount,
    treeId: params.treeId,
    ...(params.refundLink !== undefined ? { refundLink: params.refundLink } : {}),
  })

  return {
    to: params.protocolAddress,
    sender: params.sender,
    callData: calldataResult.data,
    ...GAS_ESTIMATES.payBlind,
    ...(params.paymaster ? { paymaster: params.paymaster } : {}),
  }
}

export interface DepositCreditUserOpParams {
  /** Receiver identity commitment */
  identityCommitment: Hex
  /** Payer commitment */
  payerCommitment: Hex
  /** Credit amount */
  amount: bigint
  /** Nonce (bytes32 hex) */
  nonce: Hex
  /** Credit expiry timestamp */
  expiry: bigint
  /** Nullifier key hash */
  nullifierKeyHash: Hex
  /** Merkle tree ID */
  treeId: bigint
  /** InvisiProtocol instance address */
  protocolAddress: Address
  /** Smart Account address */
  sender: Address
  /** Chain ID */
  chainId: bigint
  /** Paymaster config (optional, from IPP InfoResponse) */
  paymaster?: PaymasterConfig
}

export type DepositCreditUserOp = BaseUserOp

/**
 * Build UserOp for depositCredit.
 * Returns Promise for API consistency with buildPayOpenUserOp/buildPayBlindUserOp,
 * though this function does no async work.
 */
export function buildDepositCreditUserOp(
  params: DepositCreditUserOpParams,
): Promise<DepositCreditUserOp> {
  const callData = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "depositCredit",
    args: [
      params.identityCommitment,
      params.payerCommitment,
      params.amount,
      params.nonce,
      params.expiry,
      params.nullifierKeyHash,
      params.treeId,
    ],
  })

  return Promise.resolve({
    to: params.protocolAddress,
    sender: params.sender,
    callData,
    ...GAS_ESTIMATES.depositCredit,
    ...(params.paymaster ? { paymaster: params.paymaster } : {}),
  })
}
