import type { Address, Hex } from "viem"
import { buildPayOpenCalldata } from "./payer"
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
  /** External nonce from propose response. Auto-generated if not provided */
  nonce?: bigint
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
