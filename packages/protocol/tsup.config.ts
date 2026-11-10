import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        index: "src/index.ts",
        contracts: "src/contracts/index.ts",
        note: "src/note/index.ts",
        credit: "src/credit/index.ts",
        provenance: "src/provenance/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
