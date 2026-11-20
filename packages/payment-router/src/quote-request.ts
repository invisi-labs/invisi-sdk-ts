import type { SwapQuoteRequest } from "./types";
/** Preserve cancellation capability while detaching mutable financial requirements. */
export function snapshotQuoteRequest(input: SwapQuoteRequest): SwapQuoteRequest {
    const { signal, ...values } = input;
    return { ...structuredClone(values), ...(signal ? { signal } : {}) };
}
