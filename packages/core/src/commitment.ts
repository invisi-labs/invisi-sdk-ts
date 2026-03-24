import { poseidonHash } from "./poseidon"
import { D_IDENT, D_PAY } from "./domains"

export async function computeIdentityCommitment(
  nullifierKey: bigint,
  receivingAddress: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_IDENT, nullifierKey, receivingAddress])
}

export async function computePaymentCommitment(
  chainId: bigint,
  identityCommitment: `0x${string}`,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_PAY, chainId, BigInt(identityCommitment), tokenAddress, amount, nonce])
}

export async function computeChangeCommitment(
  chainId: bigint,
  changeNullifierKey: bigint,
  changeReceivingAddress: bigint,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  const changeIdentityComm = await computeIdentityCommitment(changeNullifierKey, changeReceivingAddress)
  return poseidonHash([D_PAY, chainId, BigInt(changeIdentityComm), tokenAddress, amount, nonce])
}

/** @deprecated Use computeIdentityCommitment */
export const computeReceiverCommitment = computeIdentityCommitment
