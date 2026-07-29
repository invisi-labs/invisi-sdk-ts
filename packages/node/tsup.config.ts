import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@aztec/bb.js"],
  },
  {
    // Browser-safe entry: no node:fs. Circuits are bundled as code-split chunks
    // via dynamic import() so consumers (Vite) lazy-load each circuit.
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: true,
    external: ["@aztec/bb.js"],
  },
])
