import { useState, useCallback } from "react"
import { buildPayBlindCalldata, type PayBlindParams, type PayBlindCalldata } from "@invisi-labs/payer"

type Status = "idle" | "preparing" | "ready" | "error"

export interface UsePayBlindResult {
  status: Status
  calldata: PayBlindCalldata | null
  error: Error | null
  prepare: (params: PayBlindParams) => Promise<void>
}

export function usePayBlind(): UsePayBlindResult {
  const [status, setStatus] = useState<Status>("idle")
  const [calldata, setCalldata] = useState<PayBlindCalldata | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const prepare = useCallback(async (params: PayBlindParams) => {
    setStatus("preparing")
    setError(null)
    try {
      const result = await buildPayBlindCalldata(params)
      setCalldata(result)
      setStatus("ready")
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus("error")
    }
  }, [])

  return { status, calldata, error, prepare }
}
