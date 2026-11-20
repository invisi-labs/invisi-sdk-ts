/** Independent authenticated Core and Periphery catalogs; host selection never changes trust. */
export const PROVER_ASSET_INDEX_SHA256 =
    "36f58bac1a0f70c6f8422b47f7cc35a30416a20f8a0f30038d23db0832e2bc93";
export const CORE_ASSET_INDEX_SHA256 = PROVER_ASSET_INDEX_SHA256;
export const PROVENANCE_ASSET_INDEX_SHA256 =
    "8d5a3e60e3e5cbe315150511207d7aff67f4e2924148d396b67d82017ecd1f1c";
export const LEGACY_PROVER_ASSET_INDEX_SHA256 =
    "ca3ee827c620b1e25d87d1b880549f8cec4be4970f26ea0ab5993dc2db4c827c";
/** Historical combined release, used only by explicit legacy initial-payment loading. */
export const INITIAL_PAYMENT_ASSET_INDEX_SHA256 =
    "9161f92f5789d8eedae15b23fa2651d5399f64ff8fbfc8de6f3f683f0d93be36";
export const PROVER_ASSET_BASE_URL = `https://assets.invisipay.fi/prover/sets/${PROVER_ASSET_INDEX_SHA256}/`;
export type ResourceRelease = "split" | "legacy";
export function coreResourcePin(release: ResourceRelease = "split"): string {
    if (release !== "split" && release !== "legacy") throw Error("Unknown resource release mode");
    return release === "legacy" ? LEGACY_PROVER_ASSET_INDEX_SHA256 : PROVER_ASSET_INDEX_SHA256;
}
export function provenanceResourcePin(release: ResourceRelease = "split"): string {
    coreResourcePin(release);
    return release === "legacy" ? LEGACY_PROVER_ASSET_INDEX_SHA256 : PROVENANCE_ASSET_INDEX_SHA256;
}
export function circuitResourcePin(name: string, release: ResourceRelease = "split"): string {
    const pin = coreResourcePin(release);
    return release === "legacy" && name === "create_credit_initial_payment"
        ? INITIAL_PAYMENT_ASSET_INDEX_SHA256
        : pin;
}
