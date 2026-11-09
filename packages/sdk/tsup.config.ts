import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        note: "src/note/index.ts",
        credit: "src/credit/index.ts",
        index: "src/index.ts",
        "session-support": "src/session-support.ts",
        ethers: "src/integrations/ethers.ts",
    },
    format: ["esm", "cjs"],
    splitting: true,
    dts: true,
    sourcemap: true,
    clean: true,
});
