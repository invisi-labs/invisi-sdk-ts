import { defineConfig } from "tsup";
export default defineConfig({
    entry: ["src/index.ts", "src/native.ts", "src/aggregate.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["@aztec-foundation/bb.js"],
});
