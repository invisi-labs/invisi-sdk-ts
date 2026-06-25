import { encode, decode } from "@msgpack/msgpack"
import { validateIPPRequest } from "./validate"
import type { IPPMessage, IPPRequest, IPPVoucher, IPPFormat } from "./types"

const IPP_PREFIX = "ipp"

// ---------------------------------------------------------------------------
// Internal shared envelope encode / decode helpers
// ---------------------------------------------------------------------------

function encodeMessage(msg: IPPMessage, format: IPPFormat): string {
  // Wire is snake_case; TS keeps camelCase property names and
  // converts only at this serialization boundary, so the same wire contract
  // round-trips with the Go SDK.
  const clean = keysToSnake(stripUndefined(msg))

  if (format === "json") {
    return JSON.stringify(clean)
  }

  // compact: MessagePack + Base64URL with ipp{v}: prefix
  const packed = encode(clean)
  const base64 = base64UrlEncode(packed)
  return `${IPP_PREFIX}${msg.v}:${base64}`
}

function decodeMessage(encoded: string): IPPMessage {
  let msg: IPPMessage

  if (encoded.startsWith("{")) {
    // Wire is snake_case; convert back to camelCase property names
    // that the rest of the SDK accesses.
    msg = keysToCamel(JSON.parse(encoded)) as IPPMessage
  } else if (encoded.startsWith(IPP_PREFIX)) {
    const colonIdx = encoded.indexOf(":")
    if (colonIdx === -1) {
      throw new Error("Invalid compact IPP format: missing colon separator")
    }
    const prefixVersion = Number(encoded.slice(IPP_PREFIX.length, colonIdx))
    if (Number.isNaN(prefixVersion) || prefixVersion < 1) {
      throw new Error(
        `Invalid compact IPP format: invalid version in prefix "${encoded.slice(0, colonIdx)}"`,
      )
    }
    const payload = encoded.slice(colonIdx + 1)
    const bytes = base64UrlDecode(payload)
    msg = keysToCamel(decode(bytes)) as IPPMessage
    if (msg.v !== prefixVersion) {
      throw new Error(
        `IPP version mismatch: prefix says v${prefixVersion} but payload has v=${msg.v}`,
      )
    }
  } else {
    throw new Error(
      `Unknown IPP format: expected JSON (starts with "{") or compact (starts with "${IPP_PREFIX}")`,
    )
  }

  return msg
}

// ---------------------------------------------------------------------------
// Public encode functions
// ---------------------------------------------------------------------------

export function encodeIPPRequest(request: IPPRequest, format: IPPFormat): string {
  validateIPPRequest(request)
  return encodeMessage(request, format)
}

export function encodeIPPVoucher(voucher: IPPVoucher, format: IPPFormat): string {
  return encodeMessage(voucher, format)
}

// ---------------------------------------------------------------------------
// Public decode functions
// ---------------------------------------------------------------------------

export function decodeIPPMessage(encoded: string): IPPMessage {
  return decodeMessage(encoded)
}

export function decodeIPPRequest(encoded: string): IPPRequest {
  const m = decodeMessage(encoded)
  if (m.type !== "request") throw new Error(`expected type "request", got "${m.type}"`)
  validateIPPRequest(m as IPPRequest)
  return m as IPPRequest
}

export function decodeIPPVoucher(encoded: string): IPPVoucher {
  const m = decodeMessage(encoded)
  if (m.type !== "voucher") throw new Error(`expected type "voucher", got "${m.type}"`)
  return m as IPPVoucher
}

// ---------------------------------------------------------------------------
// camelCase ↔ snake_case key conversion (wire boundary)
// ---------------------------------------------------------------------------
//
// Only object KEYS are converted, never values. The `meta` field is a
// Record<string,string> of business-convention keys (merchantName, orderId,
// expiresAt, invisi.subscriptionId — see meta.ts IPP_META_KEYS); its inner keys
// are exempt and passed through verbatim (the field name "meta" itself is a
// single word, unchanged either direction). Conversion is fully recursive
// across nested objects and arrays of objects (e.g. witness.merkleProofs).

const META_KEY = "meta"

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

function convertKeys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeys(item, convert))
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // `meta` value is a plain string map of business keys — recurse no
      // further and keep its inner keys verbatim (namespaced keys like
      // "invisi.subscriptionId" must survive untouched).
      out[convert(k)] = k === META_KEY ? v : convertKeys(v, convert)
    }
    return out
  }
  return value
}

// Exported so the IPP HTTP client (client.ts) converts at the same wire
// boundary as the QR/msgpack envelope path — one snake_case wire contract,
// shared key-conversion semantics (meta exempt, fully recursive).
export function keysToSnake(value: unknown): unknown {
  return convertKeys(value, camelToSnake)
}

export function keysToCamel(value: unknown): unknown {
  return convertKeys(value, snakeToCamel)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripUndefined(obj: IPPMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    if (key === "payload" && typeof value === "object" && value !== null) {
      const cleanPayload: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        if (pv !== undefined) {
          cleanPayload[pk] = pv
        }
      }
      result[key] = cleanPayload
    } else {
      result[key] = value
    }
  }
  return result
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/")
  const pad = base64.length % 4
  if (pad === 2) base64 += "=="
  else if (pad === 3) base64 += "="
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
