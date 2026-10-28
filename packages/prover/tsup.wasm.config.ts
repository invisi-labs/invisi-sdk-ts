import { defineConfig } from "tsup";
/** Run after the main build so its declaration cleanup cannot remove this browser entry. */
export default defineConfig({
    entry: { wasm: "src/wasm.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: false,
    clean: false,
    splitting: true,
    external: ["@aztec-foundation/bb.js"],
});
