import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Poseidon / bb.js WASM cold-init can exceed the 5s default on slow CI runners.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
