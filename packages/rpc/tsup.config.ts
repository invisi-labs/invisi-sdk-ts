import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        broadcaster: "src/broadcaster.ts",
        "provenance": "src/provenance/index.ts",
        index: "src/index.ts",
        "trusted-provider": "src/trusted-provider.ts",
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
