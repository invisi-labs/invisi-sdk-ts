import { defineConfig } from "tsup";
export default defineConfig({
    entry: { index: "src/index.ts", invisi: "src/methods/invisi/index.ts" },
    format: ["esm", "cjs"],
    splitting: true,
    dts: true,
    sourcemap: true,
    clean: true,
});
