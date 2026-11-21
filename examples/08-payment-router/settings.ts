// Legacy native-only examples 01/02. Canonical host examples accept their own deployment.
// Configure verified addresses for the same chain as examples/settings.ts.
// Zero placeholders deliberately fail before quoting or proving.
export const routerSettings = {
    routerAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    wethAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    uniswapRouterAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    quoterV2Address: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    allowanceHolderAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    settlerRegistryAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    // Maximum native input, excluding the wallet's separate network gas budget.
    maxInput: 100000000000000000n,
};
