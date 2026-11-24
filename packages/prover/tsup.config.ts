import { defineConfig } from "tsup";
export default defineConfig({
    entry: ["src/index.ts", "src/native.ts", "src/aggregate.ts", "src/provenance-witness.ts"],
    format: ["esm", "cjs"],
    // Compact published code; retain source maps for debugging.
    esbuildOptions(options) {
        options.minifyWhitespace = true;
        options.minifySyntax = true;
        options.minifyIdentifiers = true;
        options.keepNames = true;
    },
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["@aztec-foundation/bb.js"],
});
