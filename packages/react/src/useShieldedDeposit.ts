import { useState, useCallback } from "react"
import { buildPayShieldedCalldata, type PayShieldedParams, type PayShieldedCalldata } from "@invisi/payer"

type Status = "idle" | "preparing" | "ready" | "error"

export interface UseShieldedDepositResult {
  status: Status
  calldata: PayShieldedCalldata | null
  error: Error | null
  prepare: (params: PayShieldedParams) => Promise<void>
}

export function useShieldedDeposit(): UseShieldedDepositResult {
  const [status, setStatus] = useState<Status>("idle")
  const [calldata, setCalldata] = useState<PayShieldedCalldata | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const prepare = useCallback(async (params: PayShieldedParams) => {
    setStatus("preparing")
    setError(null)
    try {
      const result = await buildPayShieldedCalldata(params)
      setCalldata(result)
      setStatus("ready")
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus("error")
    }
  }, [])

  return { status, calldata, error, prepare }
}
