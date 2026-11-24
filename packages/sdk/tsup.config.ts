import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        provenance: "src/provenance.ts",
        note: "src/note/index.ts",
        credit: "src/credit/index.ts",
        index: "src/index.ts",
        "session-support": "src/session-support.ts",
        ethers: "src/integrations/ethers.ts",
    },
    format: ["esm", "cjs"],
    // Compact published code; retain source maps for debugging.
    esbuildOptions(options) {
        options.minifyWhitespace = true;
        options.minifySyntax = true;
        options.minifyIdentifiers = true;
        options.keepNames = true;
    },
    splitting: true,
    dts: true,
    sourcemap: true,
    clean: true,
});
