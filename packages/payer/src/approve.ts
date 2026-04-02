import { encodeFunctionData } from "viem"
import type { Address, Hex } from "viem"

export interface ApproveCalldataParams {
  /** InvisiProtocol instance address (spender) */
  protocolAddress: Address
  /** ERC-20 token address */
  token: Address
  /** Approval amount */
  amount: bigint
}

export interface ApproveCalldata {
  /** Token contract address */
  to: Address
  /** approve(spender, amount) calldata */
  callData: Hex
}

const erc20ApproveAbi = [
  {
    type: "function" as const,
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
] as const

export function buildApproveCalldata(
  params: ApproveCalldataParams,
): ApproveCalldata {
  const callData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [params.protocolAddress, params.amount],
  })

  return {
    to: params.token,
    callData,
  }
}
