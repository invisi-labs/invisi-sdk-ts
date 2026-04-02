import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi-labs/contracts"
import { poseidonHash, D_DERIVE, generateNonce } from "@invisi-labs/core"

export interface CreditAuthorization {
  creditId: bigint
  identityCommitment: `0x${string}`
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
  identityCommitment: `0x${string}`
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
  const { deriveNullifierKey, computeIdentityCommitment, computeNullifierKeyHash } = await import("@invisi-labs/core")

  const payerNullifierKey = await deriveNullifierKey(params.payerMasterKey, params.creditId)
  const payerCommitment = await computeIdentityCommitment(payerNullifierKey, params.payerAddress)
  // Deterministic derivation: creditNullifierKey = Poseidon2(D_DERIVE, payerNullifierKey, creditId)
  const creditNullifierKeyHash = await poseidonHash([D_DERIVE, payerNullifierKey, params.creditId])
  const creditNullifierKey = BigInt(creditNullifierKeyHash)
  const nullifierKeyHash = await computeNullifierKeyHash(creditNullifierKey)
  const nonce = generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "depositCredit",
    args: [
      params.identityCommitment,
      payerCommitment,
      params.amount,
      nonceHex,
      params.expiry,
      nullifierKeyHash,
      params.treeId,
    ],
  })

  return {
    authorization: {
      creditId: params.creditId,
      identityCommitment: params.identityCommitment,
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
    abi: invisiProtocolAbi,
    functionName: "reclaim",
    args: [
      params.proof,
      params.merkleRoot,
      params.nullifier,
      params.amount,
      params.receivingAddress,
      params.treeId,
      params.expiry,
    ],
  })

  return { data, nullifier: params.nullifier }
}
