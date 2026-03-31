import { computePaymentCommitment } from "@invisi-labs/core"

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export interface ComputePaymentCommitmentForProposeParams {
  identityCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  chainId: bigint
}

export interface ProposeResult {
  nonce: `0x${string}`
  paymentCommitment: `0x${string}`
}

function generateNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt(
    "0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(""),
  )
  return raw % FIELD_MODULUS
}

export async function computePaymentCommitmentForPropose(
  params: ComputePaymentCommitmentForProposeParams,
): Promise<ProposeResult> {
  const nonce = generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`

  const paymentCommitment = await computePaymentCommitment(
    params.chainId,
    params.identityCommitment,
    BigInt(params.tokenAddress),
    params.amount,
    nonce,
  )

  return { nonce: nonceHex, paymentCommitment }
}
