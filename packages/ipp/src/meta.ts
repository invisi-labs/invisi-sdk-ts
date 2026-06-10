export const IPP_META_KEYS = Object.freeze({
  /** 商家名称 */
  MERCHANT_NAME: "merchantName",
  /** 订单号 */
  ORDER_ID: "orderId",
  /** 支付说明 */
  DESCRIPTION: "description",
  /** 过期时间，ISO 8601 格式 */
  EXPIRES_AT: "expiresAt",
  /** 订阅 ID */
  SUBSCRIPTION_ID: "invisi.subscriptionId",
} as const)
