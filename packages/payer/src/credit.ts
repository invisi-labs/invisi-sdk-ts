import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi-labs/contracts"

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
  /** Server-assigned nonce from the IPP `authorize` response. */
  nonce: bigint
  expiry: bigint
  treeId: bigint
  chainId: bigint
  /** Downlinked in the authorize response; server-derived from receiverMasterKey. */
  creditNullifierKey: bigint
  /** Returned by the server; verified against the local recompute (step 1). */
  nullifierKeyHash: `0x${string}`
  /** Returned by the server; verified against the local recompute (step 2). */
  creditCommitment: `0x${string}`
}

export interface CreateCreditResult {
  authorization: CreditAuthorization
  data: `0x${string}`
  approveAmount: bigint
}

export async function createCredit(params: CreateCreditParams): Promise<CreateCreditResult> {
  const { deriveNullifierKey, computeIdentityCommitment, computeNullifierKeyHash, computeCreditCommitment } =
    await import("@invisi-labs/core")

  const payerNullifierKey = await deriveNullifierKey(params.payerMasterKey, params.creditId)
  const payerCommitment = await computeIdentityCommitment(payerNullifierKey, params.payerAddress)

  // creditNullifierKey is server-derived (Poseidon2(D_CREDIT_NKEY,
  // receiverMasterKey, creditId)) and downlinked in the authorize response. The
  // payer recomputes the hash locally; depositCredit binds THIS value so the
  // reclaim safety anchor never trusts the server's returned hash.
  const nullifierKeyHash = await computeNullifierKeyHash(params.creditNullifierKey)

  // Client two-step verification. Either failure MUST abort — no depositCredit.
  // Step 1: the returned key/hash pair is mutually consistent.
  if (params.nullifierKeyHash.toLowerCase() !== nullifierKeyHash.toLowerCase()) {
    throw new Error(
      "createCredit: authorize nullifierKeyHash does not match Poseidon2(D_NKHASH, creditNullifierKey)",
    )
  }
  // Step 2: the server folded the correct nonce into the commitment (recompute with the LOCAL hash).
  const recomputedCommitment = await computeCreditCommitment(
    params.chainId,
    params.identityCommitment,
    payerCommitment,
    BigInt(params.tokenAddress),
    params.amount,
    params.nonce,
    params.expiry,
    nullifierKeyHash,
  )
  if (recomputedCommitment.toLowerCase() !== params.creditCommitment.toLowerCase()) {
    throw new Error(
      "createCredit: recomputed creditCommitment does not match the authorize response",
    )
  }

  const nonce = params.nonce
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
      nullifierKeyHash, // local recompute — reclaim safety anchor
      params.treeId,
    ],
  })

  return {
    authorization: {
      creditId: params.creditId,
      identityCommitment: params.identityCommitment,
      payerCommitment,
      creditNullifierKey: params.creditNullifierKey,
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

/**
 * Derives the single nonce-independent payer-side value (payerCommitment) needed
 * to populate an IPP credit authorize request. Depends only on payerMasterKey,
 * creditId, payerAddress. The payer does not know creditNullifierKey before
 * authorize — the server derives it and downlinks it in the response, which
 * createCredit consumes verbatim, recomputing only the hash locally.
 */
export async function deriveCreditAuthorizeFields(
  payerMasterKey: bigint,
  creditId: bigint,
  payerAddress: bigint,
): Promise<{ payerCommitment: `0x${string}` }> {
  const { deriveNullifierKey, computeIdentityCommitment } = await import("@invisi-labs/core")

  const payerNullifierKey = await deriveNullifierKey(payerMasterKey, creditId)
  const payerCommitment = await computeIdentityCommitment(payerNullifierKey, payerAddress)

  return { payerCommitment }
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
