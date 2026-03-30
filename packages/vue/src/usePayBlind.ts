import { ref } from "vue"
import { buildPayBlindCalldata, type PayBlindParams, type PayBlindCalldata } from "@invisi/payer"

export function usePayBlind() {
  const status = ref<"idle" | "preparing" | "ready" | "error">("idle")
  const calldata = ref<PayBlindCalldata | null>(null)
  const error = ref<Error | null>(null)

  async function prepare(params: PayBlindParams) {
    status.value = "preparing"
    error.value = null
    try {
      calldata.value = await buildPayBlindCalldata(params)
      status.value = "ready"
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = "error"
    }
  }

  return { status, calldata, error, prepare }
}
