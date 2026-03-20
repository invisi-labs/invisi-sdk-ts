import { encodeFunctionData } from "viem"
import { invisiPoolAbi } from "@invisi/contracts"

// BN254 field modulus
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export interface PayPublicParams {
  receiverCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
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
    ],
  })

  return {
    paymentCommitment: paymentCommitment as `0x${string}`,
    nonce: nonceHex,
    data,
    approveAmount: params.amount,
  }
}
