import { execFile } from "node:child_process"
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function checkBBAvailable(bbBin = "bb"): Promise<boolean> {
  try {
    await execFileAsync(bbBin, ["--version"], {})
    return true
  } catch {
    return false
  }
}

export async function proveWithBB(params: {
  acirPath: string
  witness: Uint8Array
  bbBin?: string
}): Promise<`0x${string}`> {
  const bbBin = params.bbBin ?? "bb"
  const tmpDir = await mkdtemp(join(tmpdir(), "invisi-proof-"))

  try {
    const witnessPath = join(tmpDir, "witness.gz")

    await writeFile(witnessPath, params.witness)

    const vkDir = join(tmpDir, "vk_out")
    const proofDir = join(tmpDir, "proof_out")

    // Write verification key first (required by bb prove)
    // bb write_vk writes to <vkDir>/vk
    await execFileAsync(bbBin, [
      "write_vk",
      "-b", params.acirPath,
      "-o", vkDir,
    ], { timeout: 120_000 })

    // bb prove writes to <proofDir>/proof
    await execFileAsync(bbBin, [
      "prove",
      "-b", params.acirPath,
      "-w", witnessPath,
      "-k", join(vkDir, "vk"),
      "-o", proofDir,
    ], { timeout: 120_000 })

    const proofBytes = await readFile(join(proofDir, "proof"))
    return `0x${proofBytes.toString("hex")}` as `0x${string}`
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
