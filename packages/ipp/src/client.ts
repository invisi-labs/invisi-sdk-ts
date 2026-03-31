import type {
  InfoRequest, InfoResponse,
  ProposeRequest, ProposeResponse,
  AuthorizeRequest, AuthorizeResponse,
  StatusResponse,
  NotifyRequest, NotifyResponse,
  WithdrawRequest, WithdrawResponse,
  CreditDrawRequest, CreditDrawResponse,
  CreditReclaimRequest, CreditReclaimResponse,
  CreditStatusResponse,
  RelayRequest, RelayResponse, RelayProveResponse,
  RelayStatusResponse,
  ErrorResponse,
} from "./interaction-types"

export class IPPClient {
  private readonly baseUrl: string

  constructor(endpoint: string) {
    const trimmed = endpoint.replace(/\/+$/, "")
    this.baseUrl = `${trimmed}/ipp/v1`
  }

  async info(params: InfoRequest): Promise<InfoResponse> {
    return this.post<InfoResponse>("info", params)
  }

  async propose(params: ProposeRequest): Promise<ProposeResponse> {
    return this.post<ProposeResponse>("propose", params)
  }

  async authorize(params: AuthorizeRequest): Promise<AuthorizeResponse> {
    return this.post<AuthorizeResponse>("authorize", params)
  }

  async status(paymentCommitment: string): Promise<StatusResponse> {
    return this.get<StatusResponse>(`status/${paymentCommitment}`)
  }

  async notify(params: NotifyRequest): Promise<NotifyResponse> {
    return this.post<NotifyResponse>("notify", params)
  }

  async withdraw(params: WithdrawRequest): Promise<WithdrawResponse> {
    return this.post<WithdrawResponse>("withdraw", params)
  }

  async creditDraw(params: CreditDrawRequest): Promise<CreditDrawResponse> {
    return this.post<CreditDrawResponse>("credit-draw", params)
  }

  async creditReclaim(params: CreditReclaimRequest): Promise<CreditReclaimResponse> {
    return this.post<CreditReclaimResponse>("credit-reclaim", params)
  }

  async creditStatus(creditCommitment: string): Promise<CreditStatusResponse> {
    return this.get<CreditStatusResponse>(`credit/${creditCommitment}`)
  }

  async relay(params: RelayRequest): Promise<RelayResponse | RelayProveResponse> {
    return this.post<RelayResponse | RelayProveResponse>("relay", params)
  }

  async relayStatus(relayId: string): Promise<RelayStatusResponse> {
    return this.get<RelayStatusResponse>(`relay/${relayId}`)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return this.handleResponse<T>(res)
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
    return this.handleResponse<T>(res)
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    const data = await res.json()
    if (!res.ok) {
      const err = data as ErrorResponse
      throw new Error(err.error ?? `HTTP ${res.status}`, { cause: err })
    }
    return data as T
  }
}
