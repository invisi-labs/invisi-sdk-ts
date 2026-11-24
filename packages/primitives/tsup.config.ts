import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        note: "src/note/index.ts",
        credit: "src/credit/index.ts",
        index: "src/index.ts",
        address: "src/address-entry.ts",
    },
    format: ["esm", "cjs"],
    // Compact published code; retain source maps for debugging.
    esbuildOptions(options) {
        options.minifyWhitespace = true;
        options.minifySyntax = true;
        options.minifyIdentifiers = true;
        options.keepNames = true;
    },
    dts: true,
    sourcemap: true,
    clean: true,
});
