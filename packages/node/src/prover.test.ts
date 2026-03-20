import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("deadbeef", "hex")),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/invisi-proof-abc"),
  rm: vi.fn().mockResolvedValue(undefined),
}))

import { checkBBAvailable, generateProof } from "./prover"
import { execFile } from "node:child_process"

const mockExecFile = vi.mocked(execFile)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecFile.mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1]
    if (typeof cb === "function") {
      cb(null, "", "")
    }
    return {} as any
  })
})

describe("checkBBAvailable", () => {
  it("returns true when bb exits successfully", async () => {
    const result = await checkBBAvailable("bb")
    expect(result).toBe(true)
  })

  it("returns false when bb is not found", async () => {
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === "function") {
        cb(new Error("not found"), "", "")
      }
      return {} as any
    })
    const result = await checkBBAvailable("bb")
    expect(result).toBe(false)
  })
})

describe("generateProof", () => {
  it("returns a 0x-prefixed hex proof", async () => {
    const proof = await generateProof({
      circuitName: "single_settle",
      witness: { claiming_key: "42", amount: "1000000000000000000" },
    })
    expect(proof).toMatch(/^0x[0-9a-f]+$/i)
  })
})
