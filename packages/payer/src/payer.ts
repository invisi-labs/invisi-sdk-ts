import { encodeFunctionData } from "viem"
import { invisiPoolAbi } from "@invisi/contracts"

// BN254 field modulus
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export interface PayPublicParams {
  receiverCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  treeId: bigint
}

export interface PayPublicCalldata {
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

export async function buildPayPublicCalldata(
  params: PayPublicParams
): Promise<PayPublicCalldata> {
  const { poseidonHash } = await import("@invisi/core")
  const nonce = generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const paymentCommitment = await poseidonHash([
    BigInt(params.receiverCommitment) % FIELD_MODULUS,
    BigInt(params.tokenAddress) % FIELD_MODULUS,
    params.amount % FIELD_MODULUS,
    nonce % FIELD_MODULUS,
  ])

  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "payPublic",
    args: [
      params.receiverCommitment,
      { addr: params.tokenAddress, amount: params.amount },
      nonceHex,
      params.treeId,
    ],
  })

  return {
    paymentCommitment: paymentCommitment as `0x${string}`,
    nonce: nonceHex,
    data,
    approveAmount: params.amount,
  }
}

export interface PayShieldedParams {
  proof: `0x${string}`
  paymentCommitment: `0x${string}`
  changeCommitment: `0x${string}`
  inputAmount: bigint
  tokenAddress: `0x${string}`
  treeId: bigint
}

export interface PayShieldedCalldata {
  data: `0x${string}`
  approveAmount: bigint
}

export async function buildPayShieldedCalldata(
  params: PayShieldedParams
): Promise<PayShieldedCalldata> {
  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "payShielded",
    args: [
      params.proof,
      params.paymentCommitment,
      params.changeCommitment,
      params.inputAmount,
      params.tokenAddress,
      params.treeId,
    ],
  })

  return {
    data,
    approveAmount: params.inputAmount,
  }
}

/** Payer's local record of change from a shielded payment, for later recovery via settleSingle */
export interface ChangeRecord {
  treeId: bigint
  leafIndex: number
  claimingKey: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
}

export interface SettleChangeParams {
  claimingKey: bigint
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
  const { computeNullifier } = await import("@invisi/core")
  const nullifier = await computeNullifier(
    params.claimingKey,
    BigInt(params.tokenAddress),
    params.amount,
    params.nonce
  )

  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "settleSingle",
    args: [
      params.proof,
      params.merkleRoot,
      nullifier as `0x${string}`,
      params.receivingAddress,
      params.tokenAddress,
      params.amount,
      params.treeId,
    ],
  })

  return { nullifier: nullifier as `0x${string}`, data }
}
