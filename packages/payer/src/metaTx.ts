import type { Hex, Address } from "viem"

// BN254 field modulus (same as payer.ts)
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

function generateNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt("0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(""))
  return raw % FIELD_MODULUS
}

// ─── EIP-712 Domain ──────────────────────────────────────────────────

export interface EIP712DomainParams {
  chainId: bigint
  verifyingContract: Address
}

export function getEIP712Domain(params: EIP712DomainParams) {
  return {
    name: "InvisibleProtocol",
    version: "1",
    chainId: params.chainId,
    verifyingContract: params.verifyingContract,
  } as const
}

// ─── Token Permit ────────────────────────────────────────────────────

export interface TokenPermit {
  deadline: bigint
  v: number
  r: Hex
  s: Hex
}

export const EMPTY_PERMIT: TokenPermit = {
  deadline: 0n,
  v: 0,
  r: "0x0000000000000000000000000000000000000000000000000000000000000000",
  s: "0x0000000000000000000000000000000000000000000000000000000000000000",
}

// ─── EIP-712 Types ───────────────────────────────────────────────────

const assetType = {
  Asset: [
    { name: "addr", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const

export const payPublicWithSigTypes = {
  PayPublicWithSig: [
    { name: "receiverCommitment", type: "bytes32" },
    { name: "asset", type: "Asset" },
    { name: "nonce", type: "bytes32" },
    { name: "treeId", type: "uint256" },
    { name: "refundLink", type: "bytes32" },
    { name: "sigNonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  ...assetType,
} as const

export const payShieldedWithSigTypes = {
  PayShieldedWithSig: [
    { name: "proof", type: "bytes" },
    { name: "paymentCommitment", type: "bytes32" },
    { name: "changeCommitment", type: "bytes32" },
    { name: "inputAmount", type: "uint256" },
    { name: "tokenAddress", type: "address" },
    { name: "treeId", type: "uint256" },
    { name: "refundLink", type: "bytes32" },
    { name: "sigNonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export const depositCreditWithSigTypes = {
  DepositCreditWithSig: [
    { name: "receiverCommitment", type: "bytes32" },
    { name: "payerCommitment", type: "bytes32" },
    { name: "asset", type: "Asset" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "nullifierKeyHash", type: "bytes32" },
    { name: "treeId", type: "uint256" },
    { name: "sigNonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  ...assetType,
} as const

// ─── Sign method return types ──────────────────────────────────────────────

export interface SignPayPublicResult {
  paymentCommitment: Hex
  nonce: Hex
  typedData: {
    domain: ReturnType<typeof getEIP712Domain>
    types: typeof payPublicWithSigTypes
    primaryType: "PayPublicWithSig"
    message: Record<string, unknown>
  }
}

export interface SignPayShieldedResult {
  typedData: {
    domain: ReturnType<typeof getEIP712Domain>
    types: typeof payShieldedWithSigTypes
    primaryType: "PayShieldedWithSig"
    message: Record<string, unknown>
  }
}

export interface SignDepositCreditResult {
  typedData: {
    domain: ReturnType<typeof getEIP712Domain>
    types: typeof depositCreditWithSigTypes
    primaryType: "DepositCreditWithSig"
    message: Record<string, unknown>
  }
}

// ─── signPayPublic ───────────────────────────────────────────────────

export interface SignPayPublicParams {
  chainId: bigint
  verifyingContract: Address
  receiverCommitment: Hex
  tokenAddress: Address
  amount: bigint
  treeId: bigint
  refundLink?: Hex
  sigNonce: bigint
  deadline: bigint
}

export async function buildSignPayPublicTypedData(
  params: SignPayPublicParams
): Promise<SignPayPublicResult> {
  const { poseidonHash, D_PAY } = await import("@invisi/core")
  const nonce = generateNonce()
  const nonceHex = ("0x" + nonce.toString(16).padStart(64, "0")) as Hex

  const paymentCommitment = await poseidonHash([
    D_PAY,
    params.chainId,
    BigInt(params.receiverCommitment) % FIELD_MODULUS,
    BigInt(params.tokenAddress) % FIELD_MODULUS,
    params.amount % FIELD_MODULUS,
    nonce % FIELD_MODULUS,
  ])

  const domain = getEIP712Domain({
    chainId: params.chainId,
    verifyingContract: params.verifyingContract,
  })

  const refundLink = params.refundLink ?? ("0x" + "00".repeat(32)) as Hex

  return {
    paymentCommitment: paymentCommitment as Hex,
    nonce: nonceHex,
    typedData: {
      domain,
      types: payPublicWithSigTypes,
      primaryType: "PayPublicWithSig",
      message: {
        receiverCommitment: params.receiverCommitment,
        asset: { addr: params.tokenAddress, amount: params.amount },
        nonce: nonceHex,
        treeId: params.treeId,
        refundLink,
        sigNonce: params.sigNonce,
        deadline: params.deadline,
      },
    },
  }
}

// ─── signPayShielded ─────────────────────────────────────────────────

export interface SignPayShieldedParams {
  chainId: bigint
  verifyingContract: Address
  proof: Hex
  paymentCommitment: Hex
  changeCommitment: Hex
  inputAmount: bigint
  tokenAddress: Address
  treeId: bigint
  refundLink?: Hex
  sigNonce: bigint
  deadline: bigint
}

export function buildSignPayShieldedTypedData(
  params: SignPayShieldedParams
): SignPayShieldedResult {
  const domain = getEIP712Domain({
    chainId: params.chainId,
    verifyingContract: params.verifyingContract,
  })

  const refundLink = params.refundLink ?? ("0x" + "00".repeat(32)) as Hex

  return {
    typedData: {
      domain,
      types: payShieldedWithSigTypes,
      primaryType: "PayShieldedWithSig",
      message: {
        proof: params.proof,
        paymentCommitment: params.paymentCommitment,
        changeCommitment: params.changeCommitment,
        inputAmount: params.inputAmount,
        tokenAddress: params.tokenAddress,
        treeId: params.treeId,
        refundLink,
        sigNonce: params.sigNonce,
        deadline: params.deadline,
      },
    },
  }
}

// ─── signDepositCredit ───────────────────────────────────────────────

export interface SignDepositCreditParams {
  chainId: bigint
  verifyingContract: Address
  receiverCommitment: Hex
  payerCommitment: Hex
  tokenAddress: Address
  amount: bigint
  nonce: Hex
  expiry: bigint
  nullifierKeyHash: Hex
  treeId: bigint
  sigNonce: bigint
  deadline: bigint
}

export function buildSignDepositCreditTypedData(
  params: SignDepositCreditParams
): SignDepositCreditResult {
  const domain = getEIP712Domain({
    chainId: params.chainId,
    verifyingContract: params.verifyingContract,
  })

  return {
    typedData: {
      domain,
      types: depositCreditWithSigTypes,
      primaryType: "DepositCreditWithSig",
      message: {
        receiverCommitment: params.receiverCommitment,
        payerCommitment: params.payerCommitment,
        asset: { addr: params.tokenAddress, amount: params.amount },
        nonce: params.nonce,
        expiry: params.expiry,
        nullifierKeyHash: params.nullifierKeyHash,
        treeId: params.treeId,
        sigNonce: params.sigNonce,
        deadline: params.deadline,
      },
    },
  }
}
