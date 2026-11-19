/** Content identity of the authenticated Core resource set, independent of its download host. */
export const PROVER_ASSET_INDEX_SHA256 =
    "ca3ee827c620b1e25d87d1b880549f8cec4be4970f26ea0ab5993dc2db4c827c";
export const PROVER_ASSET_BASE_URL = `https://assets.invisipay.fi/prover/sets/${PROVER_ASSET_INDEX_SHA256}/`;

/** Authenticated Core resource set introducing the combined Credit circuit. */
export const FIRST_DRAW_ASSET_INDEX_SHA256 =
    "bae15f5bd62017735a62093a60279cb9dd86abe25cafc268a46dda17ff0e2a63";
export function circuitResourcePin(name: string): string {
    return name === "create_credit_and_draw"
        ? FIRST_DRAW_ASSET_INDEX_SHA256
        : PROVER_ASSET_INDEX_SHA256;
}
