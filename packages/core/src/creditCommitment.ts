import { poseidonHash } from "./poseidon"
import { D_CREDIT, D_CNULL, D_NKHASH, D_DERIVE } from "./domains"

export async function computeNullifierKeyHash(
  nullifierKey: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_NKHASH, nullifierKey])
}

export async function computeCreditCommitment(
  chainId: bigint,
  identityCommitment: `0x${string}`,
  payerCommitment: `0x${string}`,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint,
  expiry: bigint,
  nullifierKeyHash: `0x${string}`
): Promise<`0x${string}`> {
  return poseidonHash([
    D_CREDIT, chainId, BigInt(identityCommitment), BigInt(payerCommitment),
    tokenAddress, amount, nonce, expiry, BigInt(nullifierKeyHash)
  ])
}

export async function computeCreditNullifier(
  chainId: bigint,
  nullifierKey: bigint,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint,
  expiry: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_CNULL, chainId, nullifierKey, tokenAddress, amount, nonce, expiry])
}

export async function deriveRemainderNonce(
  nonce: bigint,
  newNonce: bigint
): Promise<bigint> {
  const hash = await poseidonHash([D_DERIVE, 0n, nonce, newNonce])
  return BigInt(hash)
}

export async function deriveRemainderNullifierKey(
  nullifierKey: bigint,
  newNonce: bigint
): Promise<bigint> {
  const hash = await poseidonHash([D_DERIVE, 1n, nullifierKey, newNonce])
  return BigInt(hash)
}
