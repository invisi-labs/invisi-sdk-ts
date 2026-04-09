import { encode, decode } from "@msgpack/msgpack"
import { validateIPPRequest } from "./validate"
import type { IPPRequest, IPPFormat } from "./types"

const IPP_PREFIX = "ipp"

export function encodeIPPRequest(request: IPPRequest, format: IPPFormat): string {
  validateIPPRequest(request)

  const clean = stripUndefined(request)

  if (format === "json") {
    return JSON.stringify(clean)
  }

  // compact: MessagePack + Base64URL
  const packed = encode(clean)
  const base64 = base64UrlEncode(packed)
  return `${IPP_PREFIX}${request.v}:${base64}`
}

export function decodeIPPRequest(encoded: string): IPPRequest {
  let request: IPPRequest

  if (encoded.startsWith("{")) {
    request = JSON.parse(encoded) as IPPRequest
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
    request = decode(bytes) as IPPRequest
    if (request.v !== prefixVersion) {
      throw new Error(
        `IPP version mismatch: prefix says v${prefixVersion} but payload has v=${request.v}`,
      )
    }
  } else {
    throw new Error(
      `Unknown IPP format: expected JSON (starts with "{") or compact (starts with "${IPP_PREFIX}")`,
    )
  }

  validateIPPRequest(request)
  return request
}

function stripUndefined(obj: IPPRequest): Record<string, unknown> {
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
