import type { CanonicalBlock } from "../types";
export type RpcRequest = (
    method: string,
    params: unknown[],
    signal?: AbortSignal
) => Promise<unknown>;
export type CanonicalReader = (value: unknown) => Promise<CanonicalBlock>;
