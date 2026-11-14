import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        broadcaster: "src/broadcaster.ts",
        "provenance": "src/provenance/index.ts",
        index: "src/index.ts",
        "trusted-provider": "src/trusted-provider.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
});
