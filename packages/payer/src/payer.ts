import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi-labs/contracts"
import { computePaymentCommitment } from "@invisi-labs/core"

export interface PayOpenParams {
  chainId: bigint
  identityCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  treeId: bigint
  refundLink?: bigint | undefined
  /**
   * Payment nonce. Required — the caller supplies it per the payment mode
   * (mode 1a: receiver-encoded; mode 1b/2: propose response; mode 3:
   * locally generated via generateNonce()). This builder never generates one.
   */
  nonce: bigint
}

export interface PayOpenCalldata {
  paymentCommitment: `0x${string}`
  nonce: `0x${string}`
  data: `0x${string}`
  approveAmount: bigint
  value?: bigint
}

export async function buildPayOpenCalldata(
  params: PayOpenParams
): Promise<PayOpenCalldata> {
  const nonce = params.nonce
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const paymentCommitment = await computePaymentCommitment(
    params.chainId,
    params.identityCommitment,
    BigInt(params.tokenAddress),
    params.amount,
    nonce,
  )

  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "payOpen",
    args: [
      params.identityCommitment,
      params.amount,
      nonceHex,
      params.treeId,
      ("0x" + (params.refundLink ?? 0n).toString(16).padStart(64, "0")) as `0x${string}`,
    ],
  })

  return {
    paymentCommitment: paymentCommitment as `0x${string}`,
    nonce: nonceHex,
    data,
    approveAmount: params.amount,
  }
}

export interface PayBlindParams {
  proof: `0x${string}`
  paymentCommitment: `0x${string}`
  changeCommitment: `0x${string}`
  inputAmount: bigint
  treeId: bigint
  refundLink?: bigint
}

export interface PayBlindCalldata {
  data: `0x${string}`
  approveAmount: bigint
}

export async function buildPayBlindCalldata(
  params: PayBlindParams
): Promise<PayBlindCalldata> {
  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "payBlind",
    args: [
      params.proof,
      params.paymentCommitment,
      params.changeCommitment,
      params.inputAmount,
      params.treeId,
      ("0x" + (params.refundLink ?? 0n).toString(16).padStart(64, "0")) as `0x${string}`,
    ],
  })

  return {
    data,
    approveAmount: params.inputAmount,
  }
}

/** Payer's local record of change from a shielded payment, for later recovery via withdraw */
export interface ChangeRecord {
  treeId: bigint
  leafIndex: number
  nullifierKey: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
}

export interface SettleChangeParams {
  chainId: bigint
  nullifierKey: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
  merkleRoot: `0x${string}`
  proof: `0x${string}`
  treeId: bigint
}

export interface SettleChangeCalldata {
  nullifier: `0x${string}`
  data: `0x${string}`
}

export async function buildSettleChangeCalldata(
  params: SettleChangeParams
): Promise<SettleChangeCalldata> {
  const { computePaymentNullifier } = await import("@invisi-labs/core")
  const nullifier = await computePaymentNullifier(
    params.chainId,
    params.nullifierKey,
    BigInt(params.tokenAddress),
    params.amount,
    params.nonce
  )

  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "withdraw",
    args: [
      params.proof,
      params.merkleRoot,
      [nullifier as `0x${string}`],
      params.amount,
      params.receivingAddress,
      params.treeId,
    ],
  })

  return { nullifier: nullifier as `0x${string}`, data }
}
