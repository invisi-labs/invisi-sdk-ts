// Keep the workspace's offline smoke command stable. On-chain examples have explicit scripts.
if (process.argv[2] !== "wallet") {
    throw new Error(
        "Use pnpm examples wallet, or a named example script from examples/package.json."
    );
}
await import("./00-wallet/01-wallet.js");
export {};
