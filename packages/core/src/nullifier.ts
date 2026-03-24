import { poseidonHash } from "./poseidon"
import { D_NULL } from "./domains"

export async function computePaymentNullifier(
  chainId: bigint,
  nullifierKey: bigint,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_NULL, chainId, nullifierKey, tokenAddress, amount, nonce])
}

/** @deprecated Use computePaymentNullifier */
export const computeNullifier = computePaymentNullifier
