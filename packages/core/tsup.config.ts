import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        note: "src/note/index.ts",
        credit: "src/credit/index.ts",
        index: "src/index.ts",
        address: "src/address-entry.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
