// === IPP typed errors (Channel ① — HTTP 4xx/5xx Stripe nested envelope) ===
//
// The gateway wraps every REST 4xx/5xx in a nested envelope:
//   {"error":{"type","code","message","param","request_id","details"}}
// (SPEC-057). The SDK parses that envelope and THROWS one of the typed classes
// below, chosen by `type`/`status`. Callers branch with `instanceof` (mirrors
// the Go SDK's `errors.As`). The envelope is already snake_case and is read
// verbatim into the typed error — it is NOT run through the snake→camel codec
// that success bodies use.

/** Raw nested envelope as it arrives on the wire (snake_case, read verbatim). */
export interface ErrorEnvelope {
  type?: string
  code?: string
  message?: string
  param?: string
  request_id?: string
  details?: Record<string, unknown>
}

/** Body shape carrying the nested envelope: `{ error: {...} }`. */
export interface ErrorResponse {
  error: ErrorEnvelope
}

export interface IppErrorFields {
  type: string
  code: string
  message: string
  param?: string | undefined
  requestId?: string | undefined
  statusCode: number
  details?: Record<string, unknown> | undefined
  /** The raw envelope as received, for forward-compat / debugging. */
  raw: ErrorEnvelope
}

/** Base class for all envelope-borne (Channel ①) errors. */
export class IppError extends Error {
  readonly type: string
  readonly code: string
  readonly param: string | undefined
  readonly requestId: string | undefined
  readonly statusCode: number
  readonly details: Record<string, unknown> | undefined
  readonly raw: ErrorEnvelope

  constructor(fields: IppErrorFields) {
    super(fields.message)
    // Restore prototype chain so `instanceof` works after TS downlevel/transpile.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = new.target.name
    this.type = fields.type
    this.code = fields.code
    this.param = fields.param
    this.requestId = fields.requestId
    this.statusCode = fields.statusCode
    this.details = fields.details
    this.raw = fields.raw
  }
}

/** 400 / 412 — malformed or unsatisfiable request (syntax errors, failed precondition). */
export class InvalidRequestError extends IppError {}

/** 404 — target resource (receive request / credit / commitment) not found. */
export class NotFoundError extends IppError {}

/** 409 — conflicting state. */
export class ConflictError extends IppError {}

/** 429 — rate limited. */
export class RateLimitError extends IppError {}

/** 5xx + catch-all for any status without a more specific subclass. */
export class ApiError extends IppError {}

/**
 * Transport-level failure: fetch rejection, timeout, or an error response whose
 * body is non-JSON / unparseable / missing the nested `{error:{...}}` shape.
 * Distinct from IppError because there is no envelope to type against. This is
 * what replaces the previous opaque `SyntaxError` (non-JSON body) and the
 * `[object Object]` string coercion (object thrown as Error message).
 */
export class ConnectionError extends Error {
  readonly statusCode: number | undefined
  readonly cause: unknown

  constructor(message: string, opts?: { statusCode?: number; cause?: unknown }) {
    super(message)
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = "ConnectionError"
    this.statusCode = opts?.statusCode
    this.cause = opts?.cause
  }
}

/** Narrow an arbitrary parsed body to the nested envelope shape. */
function isErrorResponse(body: unknown): body is ErrorResponse {
  return (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    (body as { error: unknown }).error !== null &&
    typeof (body as { error: unknown }).error === "object"
  )
}

/**
 * Build a typed IppError from a parsed nested-envelope body + HTTP status.
 * Picks the subclass by envelope `type` first, then falls back to `status`.
 * Returns `null` if the body is not a nested envelope (caller throws
 * ConnectionError instead).
 */
export function ippErrorFromEnvelope(body: unknown, statusCode: number): IppError | null {
  if (!isErrorResponse(body)) return null
  const env = body.error
  const fields: IppErrorFields = {
    type: env.type ?? "",
    code: env.code ?? "",
    message: env.message ?? `HTTP ${statusCode}`,
    param: env.param,
    requestId: env.request_id,
    statusCode,
    details: env.details,
    raw: env,
  }

  switch (env.type) {
    case "invalid_request_error":
      return new InvalidRequestError(fields)
    case "not_found_error":
      return new NotFoundError(fields)
    case "conflict_error":
      return new ConflictError(fields)
    case "rate_limit_error":
      return new RateLimitError(fields)
    case "api_error":
      return new ApiError(fields)
  }

  // No (or unknown) type → fall back to status. IPP is anonymous; 401/403 have
  // no dedicated subclass and land in the InvalidRequestError / ApiError split.
  switch (statusCode) {
    case 400:
    case 412:
      return new InvalidRequestError(fields)
    case 404:
      return new NotFoundError(fields)
    case 409:
      return new ConflictError(fields)
    case 429:
      return new RateLimitError(fields)
    default:
      // 5xx and any other unmapped status → ApiError catch-all.
      return new ApiError(fields)
  }
}
