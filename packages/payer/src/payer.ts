import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi-labs/contracts"

// BN254 field modulus
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export interface PayOpenParams {
  chainId: bigint
  identityCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  treeId: bigint
  refundLink?: bigint | undefined
  /** 外部提供的 nonce（如 propose 响应）。不传则内部随机生成 */
  nonce?: bigint | undefined
}

export interface PayOpenCalldata {
  paymentCommitment: `0x${string}`
  nonce: `0x${string}`
  data: `0x${string}`
  approveAmount: bigint
  value?: bigint
}

function generateNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt("0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(""))
  return raw % FIELD_MODULUS
}

export async function buildPayOpenCalldata(
  params: PayOpenParams
): Promise<PayOpenCalldata> {
  const { poseidonHash, D_PAY } = await import("@invisi-labs/core")
  const nonce = params.nonce ?? generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const paymentCommitment = await poseidonHash([
    D_PAY,
    params.chainId,
    BigInt(params.identityCommitment) % FIELD_MODULUS,
    BigInt(params.tokenAddress) % FIELD_MODULUS,
    params.amount % FIELD_MODULUS,
    nonce % FIELD_MODULUS,
  ])

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
