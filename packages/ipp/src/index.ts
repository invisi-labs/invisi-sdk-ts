// @invisi-labs/ipp — Invisible Payment Protocol data format

// === 版本 ===
export const IPP_CURRENT_VERSION = 1

// === 协议类型 ===
export type { IPPMessage, IPPMessageType, IPPRequest, IPPVoucher, IPPPayloadV1, IPPVoucherV1, PaymentType, IPPFormat } from "./types"

// === 编解码 ===
export { encodeIPPRequest, decodeIPPRequest, encodeIPPVoucher, decodeIPPVoucher, decodeIPPMessage } from "./codec"

// === 校验 ===
export { validateIPPRequest, validateIPPVoucher } from "./validate"

// === Meta 常量 ===
export { IPP_META_KEYS } from "./meta"

// === CAIP-2 工具 ===
export { chainIdToCAIP2, caip2ToChainId, SUPPORTED_NETWORKS } from "./caip2"
export type { NetworkInfo } from "./caip2"

// === 交互接口类型 ===
export type {
  PaymasterConfig,
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
  RelayOperation, RelayWitnessOperation,
} from "./interaction-types"

// === IPP wire 机器码（三通道：reject_code / relay error_code，开放字符串 + 便利常量）===
export { REJECT_CODES, RELAY_ERROR_CODES } from "./codes"
export type { RejectCode, RelayErrorCode } from "./codes"

// === IPP 类型化错误（通道① Stripe 嵌套信封）===
export {
  IppError,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ApiError,
  ConnectionError,
  ippErrorFromEnvelope,
} from "./errors"
export type { ErrorEnvelope, ErrorResponse, IppErrorFields } from "./errors"

// === IPP 客户端 ===
export { IPPClient } from "./client"

// === IPP 短链解析（传输层绑定）===
export { resolveIPPLink, resolveIPPLinkUnsafe } from "./link"
export type { ResolveIPPLinkOptions, ResolvedIPPLink } from "./link"
