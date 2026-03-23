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
      { name: "nonce", type: "bytes32" },
      { name: "treeId", type: "uint256" },
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
      { name: "treeId", type: "uint256" },
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
      { name: "treeId", type: "uint256" },
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
      { name: "treeId", type: "uint256" },
    ],
    outputs: [],
  },

  // ── View functions ───────────────────────────────────────────────────────
  {
    type: "function",
    name: "getTreeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "count", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPaymentTreeRoot",
    stateMutability: "view",
    inputs: [{ name: "treeId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "isTreeFull",
    stateMutability: "view",
    inputs: [{ name: "treeId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isNullifierSpent",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isCommitmentPaid",
    stateMutability: "view",
    inputs: [{ name: "paymentCommitment", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getSupportedTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },

  // ── Admin functions ──────────────────────────────────────────────────────
  {
    type: "function",
    name: "addSupportedToken",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "removeSupportedToken",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "updateVerifier",
    stateMutability: "nonpayable",
    inputs: [
      { name: "circuitType", type: "uint8" },
      { name: "newVerifier", type: "address" },
    ],
    outputs: [],
  },

  // ── Events ───────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "PayPublic",
    inputs: [
      { name: "paymentCommitment", type: "bytes32", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "payer", type: "address", indexed: true },
      { name: "treeId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayShielded",
    inputs: [
      { name: "paymentCommitment", type: "bytes32", indexed: true },
      { name: "paymentLeafIndex", type: "uint32", indexed: false },
      { name: "changeCommitment", type: "bytes32", indexed: true },
      { name: "changeLeafIndex", type: "uint32", indexed: false },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "inputAmount", type: "uint256", indexed: false },
      { name: "treeId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SingleSettle",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "receivingAddress", type: "address", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "treeId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchSettle",
    inputs: [
      { name: "nullifiers", type: "bytes32[]", indexed: false },
      { name: "receivingAddress", type: "address", indexed: true },
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "treeId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TreeCreated",
    inputs: [{ name: "treeId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "TokenAdded",
    inputs: [{ name: "tokenAddress", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "TokenRemoved",
    inputs: [{ name: "tokenAddress", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "VerifierUpdated",
    inputs: [
      { name: "circuitType", type: "uint8", indexed: true },
      { name: "newVerifier", type: "address", indexed: true },
    ],
  },
] as const
