import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
    resolve: {
        alias: [
            {
                find: "@invisi-labs/sdk/session-support",
                replacement: fileURLToPath(
                    new URL("../sdk/src/session-support.ts", import.meta.url)
                ),
            },
            {
                find: "@invisi-labs/sdk/ethers",
                replacement: fileURLToPath(
                    new URL("../sdk/src/integrations/ethers.ts", import.meta.url)
                ),
            },
            {
                find: "@invisi-labs/sdk",
                replacement: fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
            },
            {
                find: "@invisi-labs/session",
                replacement: fileURLToPath(new URL("../session/src/index.ts", import.meta.url)),
            },
        ],
    },
    test: { testTimeout: 30000, hookTimeout: 30000 },
});
