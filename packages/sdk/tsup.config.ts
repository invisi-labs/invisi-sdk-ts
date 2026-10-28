import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        ethers: "src/integrations/ethers.ts",
        sqlite: "src/integrations/sqlite.ts",
        indexeddb: "src/integrations/indexeddb.ts",
        memory: "src/integrations/memory.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
