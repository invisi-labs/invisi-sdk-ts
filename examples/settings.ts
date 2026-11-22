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
    chainRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    protocolRpcUrl: "https://rpc.invisipay.fi/v1/chains/97",
    tokenAddress: "0xf78DB005c9af4e9Ce4ebE6A5C162f9C42f2E4b65" as `0x${string}`,
    // Optional paid broadcasting; discovery authenticates the operator's signing identity.
    broadcasterMaxFeeAmount: 1_000_000_000_000_000_000n, // Maximum 1 iUSD (18 decimals).
    bbBin: fileURLToPath(new URL("../../invisi-core/.tools/bb/bb", import.meta.url)),
};
