import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        index: "src/index.ts",
        sqlite: "src/storage/sqlite.ts",
        indexeddb: "src/storage/indexeddb.ts",
        memory: "src/storage/memory.ts",
    },
    format: ["esm", "cjs"],
    splitting: true,
    dts: true,
    sourcemap: true,
    clean: true,
});
