import { fileURLToPath } from "node:url";

// Edit these plain values for your own testnet setup. No environment variables are required.
// Use a Chain RPC that retains historical state for wallet/disclosure verification.
export const settings = {
    // BSC Testnet is the verified default; use matching endpoints and deployment for another chain.
    chainId: 97n,
    nativeCurrencySymbol: "tBNB",
    nativeCurrencyDecimals: 18,
    suggestedGasBalance: "0.1",
    helperGasBalance: "0.01",
    chainRpcUrl: "http://127.0.0.1:18565",
    protocolRpcUrl: "https://rpc.invisipay.fi/v1/chains/97",
    tokenAddress: "0xf78DB005c9af4e9Ce4ebE6A5C162f9C42f2E4b65" as `0x${string}`,
    // Optional paid broadcasting. Pin the operator's EIP-712 quote signer independently.
    broadcasterUrl: "https://broadcaster.example.invalid",
    broadcasterSigner: "0x0000000000000000000000000000000000000000",
    broadcasterMaxFeeAmount: 1000n, // Same-token base units; edit for your token and budget.
    bbBin: fileURLToPath(new URL("./bin/bb", import.meta.url)),
};
