import { config } from "dotenv"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env") })
import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import { getDeployment } from "@invisi/deployments"

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org"

if (!PRIVATE_KEY) {
  console.error("Please set PRIVATE_KEY in .env")
  process.exit(1)
}

export const chain = baseSepolia
export const account = privateKeyToAccount(PRIVATE_KEY)

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
})

export const walletClient = createWalletClient({
  chain,
  account,
  transport: http(RPC_URL),
})

const deployment = getDeployment(chain.id)
export const PROTOCOL_ADDRESS = deployment.InvisiProtocol.address
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`

export const DEFAULT_TREE_ID = 1n
export const CHAIN_ID = BigInt(chain.id)
