import { execFile } from "node:child_process"
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface ProveParams {
  circuitName: "batch_settle_1" | "batch_settle_3" | "batch_settle_10" | "batch_settle_100" | "shielded_payment"
  witness: Record<string, string>
  bbBin?: string
  nargoBin?: string
  protocolRoot?: string
}

export async function checkBBAvailable(bbBin = "bb"): Promise<boolean> {
  try {
    await execFileAsync(bbBin, ["--version"], {})
    return true
  } catch {
    return false
  }
}

export async function generateProof(params: ProveParams): Promise<`0x${string}`> {
  const bbBin = params.bbBin ?? "bb"
  const nargoBin = params.nargoBin ?? "nargo"
  const protocolRoot = params.protocolRoot ?? process.cwd()
  const circuitDir = join(protocolRoot, "circuits", params.circuitName)
  const tmpDir = await mkdtemp(join(tmpdir(), "invisi-proof-"))
  const proverName = "Prover"

  try {
    const proverToml = Object.entries(params.witness)
      .map(([k, v]) => `${k} = "${v}"`)
      .join("\n")
    await writeFile(join(circuitDir, "Prover.toml"), proverToml)

    await execFileAsync(nargoBin, [
      "execute",
      "--program-dir", circuitDir,
      "--prover-name", proverName,
    ], { timeout: 60_000 })

    const witnessPath = join(circuitDir, "target", `${proverName}.gz`)
    const acirPath = join(circuitDir, "target", `${params.circuitName}.json`)
    const proofPath = join(tmpDir, "proof")

    await execFileAsync(bbBin, [
      "prove",
      "-b", acirPath,
      "-w", witnessPath,
      "-o", proofPath,
    ], { timeout: 120_000 })

    const proofBytes = await readFile(proofPath)
    return `0x${proofBytes.toString("hex")}` as `0x${string}`
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
    await rm(join(circuitDir, "Prover.toml"), { force: true })
  }
}
