import { generateProof, checkBBAvailable, CIRCUIT_NAMES } from "@invisi/node"

console.log("=== ZK Proof Generation ===")
console.log("")
console.log("Available circuits:", CIRCUIT_NAMES.join(", "))
console.log("")

const bbAvailable = await checkBBAvailable()
console.log("bb binary available:", bbAvailable)

console.log("")
console.log("Generating proof with WASM backend (batch_settle_1)...")

const proof = await generateProof({
  circuitName: "batch_settle_1",
  inputs: {
    claiming_keys: ["123"],
    nonces: ["42"],
    amounts: ["1000"],
    leaf_indices: ["0"],
    merkle_paths: [Array(16).fill("0")],
    chain_id: "1",
    merkle_root: "0x2ac880615f616e165e3a8dadca15b45754111108e7e069c9b908d8a938ef5128",
    nullifiers: ["0x103d706be84d179ec8b61d5c25af329aa8e45c47a03156e2dd5ded2f452caf09"],
    receiving_address: "456",
    token_address: "789",
    total_amount: "1000",
    actual_count: "1",
  },
  backend: "wasm",
})

console.log("Proof generated:", proof.slice(0, 20) + "...")
console.log("Proof length:", proof.length, "hex chars")

if (bbAvailable) {
  console.log("")
  console.log("Generating proof with bb backend...")
  const bbProof = await generateProof({
    circuitName: "batch_settle_1",
    inputs: {
      claiming_keys: ["123"],
      nonces: ["42"],
      amounts: ["1000"],
      leaf_indices: ["0"],
      merkle_paths: [Array(16).fill("0")],
      chain_id: "1",
      merkle_root: "0x2ac880615f616e165e3a8dadca15b45754111108e7e069c9b908d8a938ef5128",
      nullifiers: ["0x103d706be84d179ec8b61d5c25af329aa8e45c47a03156e2dd5ded2f452caf09"],
      receiving_address: "456",
      token_address: "789",
      total_amount: "1000",
      actual_count: "1",
    },
    backend: "bb",
  })
  console.log("bb proof generated:", bbProof.slice(0, 20) + "...")
}
