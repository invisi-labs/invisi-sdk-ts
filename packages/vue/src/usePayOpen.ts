import { ref } from "vue"
import { buildPayOpenCalldata, type PayOpenParams, type PayOpenCalldata } from "@invisi/payer"

export function usePayOpen() {
  const status = ref<"idle" | "preparing" | "ready" | "error">("idle")
  const calldata = ref<PayOpenCalldata | null>(null)
  const error = ref<Error | null>(null)

  async function prepare(params: PayOpenParams) {
    status.value = "preparing"
    error.value = null
    try {
      calldata.value = await buildPayOpenCalldata(params)
      status.value = "ready"
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = "error"
    }
  }

  return { status, calldata, error, prepare }
}
