// === IPP wire machine codes (single source for all three channels) ===
//
// All codes are lowercase snake_case with no type prefix, matching the wire
// verbatim. Types are intentionally OPEN (`(string & {})` union) so a server
// can introduce a new code without breaking the SDK — unknown codes flow
// through to the caller untouched. The named constants are convenience values
// for `switch`/comparison and double as the canonical catalog; this file is
// the seam reserved for a future generated `error-codes.json` codec.

// --- Channel ② — business reject codes (HTTP 200 {status:"rejected", reject_code}) ---
// Protocol-layer closed catalog; only TRUE business rejections (a legal request
// the receiver declines). Syntax/resource/internal errors do NOT appear here —
// those travel as the envelope `code` on a 4xx/5xx (Channel ①).
export const REJECT_CODES = [
  "insufficient_credit_balance",
  "pending_draw_exists",
  "credit_already_reclaimed",
  "credit_not_expired",
  "no_preallocated_credential",
] as const

export type RejectCode = (typeof REJECT_CODES)[number] | (string & {})

// --- Channel ③ — relay async failure codes (RelayStatusResponse.errorCode) ---
// Written by the relay worker; carried only on the STATUS poll, never on the
// synchronous Relay() response (sync success returns "queued", sync failure
// goes through the envelope). `relay_` domain prefix per protocol catalog.
export const RELAY_ERROR_CODES = [
  "relay_bad_calldata",
  "relay_resolve_failed",
  "relay_submit_failed",
  "relay_sign_failed",
  "relay_merchant_disabled",
  "relay_unknown_mode",
  "relay_missing_witness",
  "relay_kms_sign_failed",
] as const

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number] | (string & {})
