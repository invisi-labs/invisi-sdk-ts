export const invisiPoolAbi = [
  // ── Write functions ──────────────────────────────────────────────────────
  {
    type: "function",
    name: "payPublic",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiverCommitment", type: "bytes32" },
      {
        name: "asset",
        type: "tuple",
        components: [
          { name: "addr", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payShielded",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "paymentCommitment", type: "bytes32" },
      { name: "changeCommitment", type: "bytes32" },
      { name: "inputAmount", type: "uint256" },
      { name: "tokenAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payShieldedNote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "noteNullifier", type: "bytes32" },
      { name: "paymentCommitment", type: "bytes32" },
      { name: "changeCommitment", type: "bytes32" },
      { name: "tokenAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleSingle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "receivingAddress", type: "address" },
      { name: "tokenAddress", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "nullifiers", type: "bytes32[]" },
      { name: "totalAmount", type: "uint256" },
      { name: "receivingAddress", type: "address" },
      { name: "tokenAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawNote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "noteNullifier", type: "bytes32" },
      { name: "noteTreeRoot", type: "bytes32" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "tokenAddress", type: "address" },
    ],
    outputs: [],
  },

  // ── View functions ───────────────────────────────────────────────────────
  {
    type: "function",
    name: "getMerkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getNoteTreeRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "isNullifierSpent",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isCommitmentPaid",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Events ───────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "PayPublic",
    inputs: [
      { name: "receiverCommitment", type: "bytes32", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayShielded",
    inputs: [
      { name: "paymentCommitment", type: "bytes32", indexed: true },
      { name: "changeCommitment", type: "bytes32", indexed: false },
      { name: "tokenAddress", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "SingleWithdraw",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "receivingAddress", type: "address", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchWithdraw",
    inputs: [
      { name: "merkleRoot", type: "bytes32", indexed: true },
      { name: "receivingAddress", type: "address", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "totalAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "NoteWithdraw",
    inputs: [
      { name: "noteNullifier", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "withdrawAmount", type: "uint256", indexed: false },
    ],
  },
] as const
