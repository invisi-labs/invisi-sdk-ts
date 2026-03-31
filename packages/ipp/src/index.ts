// @invisi/ipp — Invisible Payment Protocol data format

// === 版本 ===
export const IPP_VERSION = 1

// === 协议类型 ===
export type { IPPRequest, PaymentType, IPPFormat } from "./types"

// === 编解码 ===
export { encodeIPPRequest, decodeIPPRequest } from "./codec"

// === 校验 ===
export { validateIPPRequest } from "./validate"

// === Meta 常量 ===
export { IPP_META_KEYS } from "./meta"

// === CAIP-2 工具 ===
export { chainIdToCAIP2, caip2ToChainId, SUPPORTED_NETWORKS } from "./caip2"
export type { NetworkInfo } from "./caip2"

// === 交互接口类型 ===
export type {
  InfoRequest, InfoResponse,
  ProposeRequest, ProposeResponse,
  AuthorizeRequest, AuthorizeResponse,
  StatusResponse,
  NotifyRequest, NotifyResponse,
  WithdrawRequest, WithdrawResponse,
  CreditDrawRequest, CreditDrawResponse,
  CreditReclaimRequest, CreditReclaimResponse,
  CreditStatusResponse,
  RelayRequest, RelaySignatureRequest, RelayCalldataRequest,
  RelayWitnessRequest, RelayProveRequest,
  RelayResponse, RelayProveResponse, RelayStatusResponse,
  RelayErrorCode, RelayOperation, RelayWitnessOperation,
  ErrorResponse,
} from "./interaction-types"

// === IPP 客户端 ===
export { IPPClient } from "./client"
