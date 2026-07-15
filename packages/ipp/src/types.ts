/** 支付类型 */
export type PaymentType = "open" | "blind" | "credit"

/** IPP message type discriminator */
export type IPPMessageType = "request" | "voucher"

/** V1 Payload — 版本特定字段 */
export interface IPPPayloadV1 {
  /** 收款方身份承诺 (0x-prefixed hex) */
  identityCommitment: string
  /** ERC20 代币合约地址 (0x-prefixed hex) */
  tokenAddress: string
  /** 运营方地址 (0x-prefixed hex)，用于定位 per-token 合约实例 */
  operator: string
  /** 收款方接受的支付类型 */
  paymentTypes: PaymentType[]
  /** 收款单模式 (wire `mode`)：'single' = 金额固定、单次有效 (1a)；'multi' = 多人多次 (1b/2)。SPEC-029 §1 */
  mode: "single" | "multi"
  /** 支付金额，原子单位 (bigint as string)。不填 = 开放金额 (仅 multi) */
  amount?: string | undefined
  /** 收款方服务地址，实现 IPP Interaction Protocol；扫码分发的请求必填 (协议基线) */
  endpoint?: string | undefined
  /** Credit authorization ID (wire `credit_id`); required when paymentTypes includes 'credit', single-use. */
  creditId?: string | undefined
  // SPEC-029: 支付材料 nonce / paymentCommitment / treeId 不再入 payload——统一经 propose 下发
  // (nonce/paymentCommitment 见 ProposeResponse, treeId 见 ProposeResponse/AuthorizeResponse)。
}

/** V1 Voucher Payload — mode 3 address transfer (payer → receiver) */
export interface IPPVoucherV1 {
  /** Receiver's address; with nullifierKey it recomputes identityCommitment / paymentCommitment, and is the settle circuit's receiving_address public input (one-way hash — identityCommitment is not reversible to this) */
  receivingAddress: string
  /** On-chain leaf: used for location and self-verification */
  paymentCommitment: string
  /** ERC20 token contract address (0x-prefixed hex) */
  tokenAddress: string
  /** Operator address (0x-prefixed hex); routes to per-token instance */
  operator: string
  /** Payment amount in atomic units (bigint as string) */
  amount: string
  /** Payment nonce (0x-prefixed hex) */
  nonce: string
  /** Settlement key — only withdrawable to the bound receiving address */
  nullifierKey: string
  /** Merkle Tree ID (bigint as string) */
  treeId: string
  /** Optional leaf index; if absent, locate by scanning PayOpen events */
  leafIndex?: string | undefined
}

/** Base IPP message envelope */
export interface IPPMessage {
  /** IPP protocol version */
  v: number
  /** CAIP-2 network identifier, e.g. "eip155:84532" */
  network: string
  /** Message type discriminator */
  type: IPPMessageType
  /** Extension fields, stable across versions */
  meta?: Record<string, string> | undefined
  /** Version-specific data */
  payload: IPPPayloadV1 | IPPVoucherV1
}

/** IPP payment request (receiver → payer) */
export type IPPRequest = IPPMessage & { type: "request"; payload: IPPPayloadV1 }

/** IPP payment voucher (payer → receiver, mode 3 address transfer) */
export type IPPVoucher = IPPMessage & { type: "voucher"; payload: IPPVoucherV1 }

/** 编码格式 */
export type IPPFormat = "json" | "compact"
