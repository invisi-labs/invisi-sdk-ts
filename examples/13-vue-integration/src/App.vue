<script setup lang="ts">
import { usePayOpen } from "@invisi-labs/vue"

const { status, calldata, error, prepare } = usePayOpen()

function handlePay() {
  prepare({
    chainId: 84532n,
    identityCommitment: "0x...",
    tokenAddress: "0x...",
    amount: 100_000_000n,
    treeId: 1n,
  })
}
</script>

<template>
  <div style="padding: 2rem; font-family: sans-serif">
    <h1>Invisi Vue Integration</h1>
    <p>Build payment calldata using the usePayOpen composable</p>
    <button @click="handlePay" :disabled="status === 'preparing'">
      {{ status === "preparing" ? "Preparing..." : "Pay 100 USDC" }}
    </button>
    <p v-if="status === 'ready'">Calldata ready</p>
    <p v-if="status === 'error'">{{ error?.message }}</p>
  </div>
</template>
