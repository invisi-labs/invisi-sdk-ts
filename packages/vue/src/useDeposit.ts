import { ref } from "vue"
import { buildPayPublicCalldata, type PayPublicParams, type PayPublicCalldata } from "@invisi/payer"

export function useDeposit() {
  const status = ref<"idle" | "preparing" | "ready" | "error">("idle")
  const calldata = ref<PayPublicCalldata | null>(null)
  const error = ref<Error | null>(null)

  async function prepare(params: PayPublicParams) {
    status.value = "preparing"
    error.value = null
    try {
      calldata.value = await buildPayPublicCalldata(params)
      status.value = "ready"
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = "error"
    }
  }

  return { status, calldata, error, prepare }
}
