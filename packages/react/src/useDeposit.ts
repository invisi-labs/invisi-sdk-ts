import { useState, useCallback } from "react"
import { buildPayPublicCalldata, type PayPublicParams, type PayPublicCalldata } from "@invisi/payer"

type Status = "idle" | "preparing" | "ready" | "error"

export interface UseDepositResult {
  status: Status
  calldata: PayPublicCalldata | null
  error: Error | null
  prepare: (params: PayPublicParams) => Promise<void>
}

export function useDeposit(): UseDepositResult {
  const [status, setStatus] = useState<Status>("idle")
  const [calldata, setCalldata] = useState<PayPublicCalldata | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const prepare = useCallback(async (params: PayPublicParams) => {
    setStatus("preparing")
    setError(null)
    try {
      const result = await buildPayPublicCalldata(params)
      setCalldata(result)
      setStatus("ready")
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus("error")
    }
  }, [])

  return { status, calldata, error, prepare }
}
