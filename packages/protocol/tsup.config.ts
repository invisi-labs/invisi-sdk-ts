import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", contracts: "src/contracts/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
