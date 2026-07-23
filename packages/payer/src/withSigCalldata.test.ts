import { describe, it, expect } from "vitest"
import { decodeFunctionData } from "viem"
import { buildPayBlindWithSigCalldata, buildPayOpenWithSigCalldata } from "./withSigCalldata"
import { invisiProtocolAbi } from "@invisi-labs/contracts"

const META = {
  signer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
  sigNonce: 0n,
  deadline: 1893456000n,
  signature: ("0x" + "11".repeat(65)) as `0x${string}`,
  permitToken: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const,
  permit: { deadline: 1893456000n, v: 27, r: ("0x" + "22".repeat(32)) as `0x${string}`, s: ("0x" + "33".repeat(32)) as `0x${string}` },
}

describe("buildPayBlindWithSigCalldata", () => {
  it("encodes payBlindWithSig with the MetaTxParams tuple; round-trips via decode", () => {
    const { data } = buildPayBlindWithSigCalldata({
      proof: ("0x" + "ab".repeat(64)) as `0x${string}`,
      paymentCommitment: ("0x" + "44".repeat(32)) as `0x${string}`,
      changeCommitment: ("0x" + "55".repeat(32)) as `0x${string}`,
      inputAmount: 1000000n, treeId: 1n, meta: META,
    })
    const d = decodeFunctionData({ abi: invisiProtocolAbi, data })
    expect(d.functionName).toBe("payBlindWithSig")
    expect((d.args[6] as any).permit.v).toBe(27)
    // refundLink defaults to zero bytes32
    expect(d.args[5]).toBe("0x" + "00".repeat(32))
  })
})

describe("buildPayOpenWithSigCalldata", () => {
  it("encodes payOpenWithSig with the MetaTxParams tuple", () => {
    const { data } = buildPayOpenWithSigCalldata({
      identityCommitment: ("0x" + "66".repeat(32)) as `0x${string}`,
      amount: 1000000n,
      nonce: ("0x" + "77".repeat(32)) as `0x${string}`,
      treeId: 1n, meta: META,
    })
    const d = decodeFunctionData({ abi: invisiProtocolAbi, data })
    expect(d.functionName).toBe("payOpenWithSig")
  })
})
