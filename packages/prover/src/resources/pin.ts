/** Content identity of the authenticated Core resource set, independent of its download host. */
export const PROVER_ASSET_INDEX_SHA256 =
    "ca3ee827c620b1e25d87d1b880549f8cec4be4970f26ea0ab5993dc2db4c827c";
export const PROVER_ASSET_BASE_URL = `https://assets.invisipay.fi/prover/sets/${PROVER_ASSET_INDEX_SHA256}/`;

/** Authenticated Core resource set introducing the combined Credit circuit. */
export const INITIAL_PAYMENT_ASSET_INDEX_SHA256 =
    "9161f92f5789d8eedae15b23fa2651d5399f64ff8fbfc8de6f3f683f0d93be36";
export function circuitResourcePin(name: string): string {
    return name === "create_credit_initial_payment"
        ? INITIAL_PAYMENT_ASSET_INDEX_SHA256
        : PROVER_ASSET_INDEX_SHA256;
}
