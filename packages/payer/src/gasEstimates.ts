import type { Address, Hex } from "viem"

/**
 * Paymaster service configuration, obtained from IPP InfoResponse or manually specified.
 * NOTE: Identical type exists in @invisi-labs/ipp (interaction-types.ts).
 * Duplicated to avoid circular dependency (payer does not depend on ipp).
 */
export interface PaymasterConfig {
  /** Paymaster service RPC URL */
  url: string
  /** Sponsorship policy ID (required by some providers) */
  policyId?: string
  /** Extension fields (required by some providers for additional params) */
  context?: Record<string, unknown>
}

/** Base return type for all UserOp builders */
export interface BaseUserOp {
  /** InvisiProtocol instance address */
  to: Address
  /** Smart Account address */
  sender: Address
  /** Encoded contract call data */
  callData: Hex
  /** Recommended callGasLimit */
  callGasLimit: bigint
  /** Recommended verificationGasLimit */
  verificationGasLimit: bigint
  /** Recommended preVerificationGas */
  preVerificationGas: bigint
  /** Paymaster info passthrough (optional) */
  paymaster?: PaymasterConfig
}

/**
 * Gas estimates for each deposit method.
 * Production use should prefer bundler's eth_estimateUserOperationGas.
 */
export const GAS_ESTIMATES = {
  payOpen: {
    callGasLimit: 150_000n,
    verificationGasLimit: 70_000n,
    preVerificationGas: 21_000n,
  },
  payBlind: {
    callGasLimit: 350_000n,
    verificationGasLimit: 70_000n,
    preVerificationGas: 21_000n,
  },
  depositCredit: {
    callGasLimit: 180_000n,
    verificationGasLimit: 70_000n,
    preVerificationGas: 21_000n,
  },
} as const

/** Default Paymaster config for protocol subsidy (cold-start phase, replace values at deployment) */
export const INVISI_DEFAULT_PAYMASTER: PaymasterConfig = {
  url: "",
  policyId: "",
}
