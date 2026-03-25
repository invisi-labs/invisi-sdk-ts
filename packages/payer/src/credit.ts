import { encodeFunctionData } from "viem"
import { invisiPoolAbi } from "@invisi/contracts"

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

function generateNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt("0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(""))
  return raw % FIELD_MODULUS
}

export interface CreditAuthorization {
  creditId: bigint
  receiverCommitment: `0x${string}`
  payerCommitment: `0x${string}`
  creditNullifierKey: bigint
  nullifierKeyHash: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
  expiry: bigint
  treeId: bigint
  chainId: bigint
}

export interface CreateCreditParams {
  payerMasterKey: bigint
  creditId: bigint
  receiverCommitment: `0x${string}`
  payerAddress: bigint
  tokenAddress: `0x${string}`
  amount: bigint
  expiry: bigint
  treeId: bigint
  chainId: bigint
}

export interface CreateCreditResult {
  authorization: CreditAuthorization
  data: `0x${string}`
  approveAmount: bigint
}

export async function createCredit(params: CreateCreditParams): Promise<CreateCreditResult> {
  const { deriveNullifierKey, computeIdentityCommitment, computeNullifierKeyHash } = await import("@invisi/core")

  const payerNullifierKey = await deriveNullifierKey(params.payerMasterKey, params.creditId)
  const payerCommitment = await computeIdentityCommitment(payerNullifierKey, params.payerAddress)
  const creditNullifierKey = generateNonce()
  const nullifierKeyHash = await computeNullifierKeyHash(creditNullifierKey)
  const nonce = generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "depositCredit",
    args: [
      params.receiverCommitment,
      payerCommitment,
      { addr: params.tokenAddress, amount: params.amount },
      nonceHex,
      params.expiry,
      nullifierKeyHash,
      params.treeId,
    ],
  })

  return {
    authorization: {
      creditId: params.creditId,
      receiverCommitment: params.receiverCommitment,
      payerCommitment,
      creditNullifierKey,
      nullifierKeyHash,
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      nonce,
      expiry: params.expiry,
      treeId: params.treeId,
      chainId: params.chainId,
    },
    data,
    approveAmount: params.amount,
  }
}

export interface BuildReclaimCalldataParams {
  nullifier: `0x${string}`
  amount: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  merkleRoot: `0x${string}`
  proof: `0x${string}`
  treeId: bigint
  expiry: bigint
}

export interface ReclaimCalldata {
  data: `0x${string}`
  nullifier: `0x${string}`
}

export async function buildReclaimCalldata(params: BuildReclaimCalldataParams): Promise<ReclaimCalldata> {
  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "reclaim",
    args: [
      params.proof,
      params.merkleRoot,
      params.nullifier,
      params.amount,
      params.receivingAddress,
      params.tokenAddress,
      params.treeId,
      params.expiry,
    ],
  })

  return { data, nullifier: params.nullifier }
}
