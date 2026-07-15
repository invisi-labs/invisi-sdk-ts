import { deriveChangeNullifierKey, computeChangeCommitment } from "@invisi-labs/core"

export interface DeriveChangeParams {
  /** REQUIRED — payBlind's necessary config; no random fallback. */
  payerMasterKey: bigint
  /** This payment's paymentCommitment (0x bytes32 hex) — the derivation salt. */
  paymentCommitment: `0x${string}`
  /** Payer's own wallet address (= PayBlind event `payer`); the change withdrawal destination. */
  changeReceivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  /** inputAmount - paymentAmount. */
  changeAmount: bigint
  /** The payment nonce — reused verbatim as changeNonce. */
  nonce: bigint
  chainId: bigint
}

export interface ChangeDerivation {
  changeNullifierKey: bigint
  changeCommitment: `0x${string}`
}

/**
 * Deterministically derives a shielded payment's change. Produces the
 * changeCommitment fed into the ZK proof and buildPayBlindCalldata, plus the
 * changeNullifierKey the caller stores in its local ChangeRecord for later withdraw.
 *
 * The derivation is fully deterministic — no randomness, no network, no lock. The salt
 * is this payment's paymentCommitment (necessarily present, already locally re-verified),
 * and changeNonce reuses the payment nonce. payerMasterKey is REQUIRED: there is no
 * random fallback (a fallback would reintroduce a branch and break the single derivation
 * rule, and change derived under a throwaway key would be unrecoverable).
 *
 * treeId / leafIndex are NOT produced here — they are known only from the propose
 * response (treeId) and the on-chain PayBlind event (leafIndex); the caller assembles
 * the full ChangeRecord after the transaction confirms, from { treeId, leafIndex,
 * changeNullifierKey, changeReceivingAddress, tokenAddress, changeAmount, nonce }.
 */
export async function deriveChange(params: DeriveChangeParams): Promise<ChangeDerivation> {
  if (params.payerMasterKey === undefined || params.payerMasterKey === null || params.payerMasterKey === 0n) {
    throw new Error(
      "deriveChange: payerMasterKey is required for payBlind change derivation (no random fallback)",
    )
  }

  const changeNullifierKey = await deriveChangeNullifierKey(
    params.payerMasterKey,
    BigInt(params.paymentCommitment),
  )
  const changeCommitment = await computeChangeCommitment(
    params.chainId,
    changeNullifierKey,
    BigInt(params.changeReceivingAddress),
    BigInt(params.tokenAddress),
    params.changeAmount,
    params.nonce, // changeNonce = payment nonce
  )

  return { changeNullifierKey, changeCommitment }
}
