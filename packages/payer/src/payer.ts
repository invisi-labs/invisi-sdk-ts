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
  data: `0x${string}`
  approveAmount: bigint
  value?: bigint
}

export async function buildPayPublicCalldata(
  params: PayPublicParams
): Promise<PayPublicCalldata> {
  const { poseidonHash } = await import("@invisi/core")
  const paymentCommitment = await poseidonHash([
    BigInt(params.receiverCommitment) % FIELD_MODULUS,
    BigInt(params.tokenAddress) % FIELD_MODULUS,
    params.amount % FIELD_MODULUS,
  ])

  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "payPublic",
    args: [
      params.receiverCommitment,
      { addr: params.tokenAddress, amount: params.amount },
    ],
  })

  return {
    paymentCommitment: paymentCommitment as `0x${string}`,
    data,
    approveAmount: params.amount,
  }
}
