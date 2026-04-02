/** 支付类型 */
export type PaymentType = "open" | "blind" | "credit"

/** IPP 支付请求 */
export interface IPPRequest {
  /** IPP 协议版本，对应 InvisiProtocol 合约版本。当前固定为 1 */
  v: number
  /** CAIP-2 网络标识，如 "eip155:84532" */
  network: string
  /** 收款方身份承诺 (0x-prefixed hex) */
  identityCommitment: string
  /** ERC20 代币合约地址 (0x-prefixed hex) */
  tokenAddress: string
  /** 运营方地址 (0x-prefixed hex)，用于定位 per-token 合约实例 */
  operator: string
  /** Merkle Tree ID (bigint as string) */
  treeId: string
  /** 收款方接受的支付类型 */
  paymentTypes: PaymentType[]
  /** 支付金额，原子单位 (bigint as string)。不填 = 开放金额 */
  amount?: string | undefined
  /** 收款方预算的 nonce (模式 1a) */
  nonce?: string | undefined
  /** 收款方预算的 paymentCommitment (模式 1a) */
  paymentCommitment?: string | undefined
  /** 收款方服务地址，实现 IPP Interaction Protocol */
  endpoint?: string | undefined
  /** 业务扩展字段 */
  meta?: Record<string, string> | undefined
}

/** 编码格式 */
export type IPPFormat = "json" | "compact"
