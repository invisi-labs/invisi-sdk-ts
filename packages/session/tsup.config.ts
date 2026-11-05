import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        index: "src/index.ts",
        sqlite: "src/integrations/sqlite.ts",
        indexeddb: "src/integrations/indexeddb.ts",
        memory: "src/integrations/memory.ts",
    },
    format: ["esm", "cjs"],
    splitting: true,
    dts: true,
    sourcemap: true,
    clean: true,
});
