import { useState, useCallback } from "react"
import { buildPayOpenCalldata, type PayOpenParams, type PayOpenCalldata } from "@invisi-labs/payer"

type Status = "idle" | "preparing" | "ready" | "error"

export interface UsePayOpenResult {
  status: Status
  calldata: PayOpenCalldata | null
  error: Error | null
  prepare: (params: PayOpenParams) => Promise<void>
}

export function usePayOpen(): UsePayOpenResult {
  const [status, setStatus] = useState<Status>("idle")
  const [calldata, setCalldata] = useState<PayOpenCalldata | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const prepare = useCallback(async (params: PayOpenParams) => {
    setStatus("preparing")
    setError(null)
    try {
      const result = await buildPayOpenCalldata(params)
      setCalldata(result)
      setStatus("ready")
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus("error")
    }
  }, [])

  return { status, calldata, error, prepare }
}
