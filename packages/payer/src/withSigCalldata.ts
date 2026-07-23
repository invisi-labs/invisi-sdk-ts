import { encodeFunctionData, type Address, type Hex } from "viem"
// Same ABI as payer.ts's buildPayBlindCalldata.
import { invisiProtocolAbi } from "@invisi-labs/contracts"
import type { TokenPermit } from "./metaTx"

const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as Hex

export interface MetaTxInput {
  signer: Address
  sigNonce: bigint
  deadline: bigint
  /** 65-byte EIP-712 meta-tx signature over PayBlindWithSig/PayOpenWithSig. */
  signature: Hex
  /** The token to permit; must equal the protocol's configured token or the
   *  call reverts WrongPermitToken. Set to zero address to skip the inline
   *  permit (only valid when allowance already exists). */
  permitToken: Address
  permit: TokenPermit
}

export interface PayBlindWithSigParams {
  proof: Hex
  paymentCommitment: Hex
  changeCommitment: Hex
  inputAmount: bigint
  treeId: bigint
  refundLink?: Hex
  meta: MetaTxInput
}

export function buildPayBlindWithSigCalldata(p: PayBlindWithSigParams): { data: Hex } {
  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "payBlindWithSig",
    args: [
      p.proof, p.paymentCommitment, p.changeCommitment,
      p.inputAmount, p.treeId, p.refundLink ?? ZERO_BYTES32, p.meta,
    ],
  })
  return { data }
}

export interface PayOpenWithSigParams {
  identityCommitment: Hex
  amount: bigint
  nonce: Hex
  treeId: bigint
  refundLink?: Hex
  meta: MetaTxInput
}

export function buildPayOpenWithSigCalldata(p: PayOpenWithSigParams): { data: Hex } {
  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "payOpenWithSig",
    args: [p.identityCommitment, p.amount, p.nonce, p.treeId, p.refundLink ?? ZERO_BYTES32, p.meta],
  })
  return { data }
}
