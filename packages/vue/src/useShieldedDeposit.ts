import { ref } from "vue"
import { buildPayShieldedCalldata, type PayShieldedParams, type PayShieldedCalldata } from "@invisi/payer"

export function useShieldedDeposit() {
  const status = ref<"idle" | "preparing" | "ready" | "error">("idle")
  const calldata = ref<PayShieldedCalldata | null>(null)
  const error = ref<Error | null>(null)

  async function prepare(params: PayShieldedParams) {
    status.value = "preparing"
    error.value = null
    try {
      calldata.value = await buildPayShieldedCalldata(params)
      status.value = "ready"
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = "error"
    }
  }

  return { status, calldata, error, prepare }
}
