import type { Address, Hex } from "viem"

// EIP-2612 Permit — standard type set. The `_tryPermit` call on-chain reconstructs
// owner=signer, spender=contract, value=amount, so this must match verbatim.
export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export interface PermitTypedDataParams {
  chainId: bigint
  /** The token contract — verifyingContract of the permit's EIP-712 domain. */
  token: Address
  /** Token EIP-712 domain name/version — resolved on-chain by the caller
   *  (EIP-5267 eip712Domain, or DOMAIN_SEPARATOR match). A wrong domain makes
   *  the on-chain permit silently no-op, so these are load-bearing. */
  name: string
  version: string
  owner: Address
  /** InvisiProtocol instance — the permit spender / transferFrom taker. */
  spender: Address
  value: bigint
  /** token.nonces(owner). */
  nonce: bigint
  deadline: bigint
}

export interface PermitTypedDataResult {
  typedData: {
    domain: { name: string; version: string; chainId: bigint; verifyingContract: Address }
    types: typeof permitTypes
    primaryType: "Permit"
    message: { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }
  }
}

export function buildPermitTypedData(p: PermitTypedDataParams): PermitTypedDataResult {
  return {
    typedData: {
      domain: { name: p.name, version: p.version, chainId: p.chainId, verifyingContract: p.token },
      types: permitTypes,
      primaryType: "Permit",
      message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
    },
  }
}
