---
"@invisi-labs/ipp": minor
---

IPPClient now handles all three IPP response channels with a typed error model, symmetric to the Go SDK (SPEC-156).

- **Channel ① (HTTP 4xx/5xx):** parses the gateway's Stripe-style nested envelope `{error:{type,code,message,param,request_id,details}}` and throws a typed error — `InvalidRequestError` (400/412), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429), `ApiError` (5xx + catch-all), all extending the base `IppError`. Fixes two bugs in `handleResponse`: it now checks `res.ok` BEFORE parsing the body (a non-JSON error body previously threw an opaque `SyntaxError`), and it no longer coerces the error object to a string (previously yielded `[object Object]`). A non-JSON / empty / shapeless error body, or a fetch rejection (network/timeout), now throws `ConnectionError` instead.
- **Channel ② (HTTP 200 business rejection):** `{status:"rejected", reject_code, reason}` is no longer mistaken for an error — it resolves normally. Added `rejectCode?: RejectCode` to `AuthorizeResponse`, `ProposeResponse`, `CreditDrawResponse`, and `CreditReclaimResponse`.
- **Channel ③ (relay async failure):** replaced the 9 bogus `RelayErrorCode` values (a dangling contract that never matched the server) with the real server codes (`relay_bad_calldata`, `relay_resolve_failed`, `relay_submit_failed`, `relay_sign_failed`, `relay_merchant_disabled`, `relay_unknown_mode`, `relay_missing_witness`, `relay_kms_sign_failed`), kept as an OPEN string type and read from `RelayStatusResponse.errorCode`. Removed the never-populated `errorCode` field from the synchronous `RelayResponse` / `RelayProveResponse`.
- New `src/codes.ts` exports the reject + relay code catalogs (`REJECT_CODES`, `RELAY_ERROR_CODES`) and open-string types (`RejectCode`, `RelayErrorCode`), all lowercase and prefix-free to match the wire — new server codes flow through without an SDK change.
