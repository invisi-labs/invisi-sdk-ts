import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", address: "src/address-entry.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
