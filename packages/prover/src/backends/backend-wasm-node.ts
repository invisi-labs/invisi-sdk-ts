import { proveWithWasm as proveBrowser, verifyWithWasm as verifyBrowser } from "./backend-wasm";
import type { WasmOptions as BrowserWasmOptions } from "./backend-wasm";
import { nodeResourceOptions, type NodeResourceOptions } from "../resources/node";
export interface WasmOptions extends Omit<BrowserWasmOptions, "resources"> {
    resources?: NodeResourceOptions;
}
export function proveWithWasm(
    params: Omit<Parameters<typeof proveBrowser>[0], "resources"> & WasmOptions
) {
    return proveBrowser({ ...params, resources: nodeResourceOptions(params.resources) });
}
export function verifyWithWasm(
    bundle: Parameters<typeof verifyBrowser>[0],
    options: WasmOptions = {}
) {
    return verifyBrowser(bundle, { ...options, resources: nodeResourceOptions(options.resources) });
}
