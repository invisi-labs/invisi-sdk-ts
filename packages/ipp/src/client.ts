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
} from "./interaction-types"
import { keysToSnake, keysToCamel } from "./codec"
import { ConnectionError, ippErrorFromEnvelope } from "./errors"

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
    const res = await this.doFetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Wire is snake_case; TS request types are camelCase — convert at the boundary.
      body: JSON.stringify(keysToSnake(body)),
    })
    return this.handleResponse<T>(res)
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}/${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
    return this.handleResponse<T>(res)
  }

  // Wrap transport-level failures (network down, DNS, timeout/abort) as
  // ConnectionError so callers see one error model, never a bare fetch reject.
  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init)
    } catch (cause) {
      throw new ConnectionError(
        cause instanceof Error ? cause.message : "network request failed",
        { cause },
      )
    }
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    // Decide success vs error FIRST. Parsing the body before this check turned
    // a non-JSON 4xx/5xx into an opaque SyntaxError; now both paths parse only
    // after the branch and any parse failure becomes a ConnectionError.
    if (!res.ok) {
      // The error envelope is already snake_case and a distinct contract —
      // read it verbatim, do not snake→camel transcode.
      let body: unknown
      try {
        body = await res.json()
      } catch (cause) {
        // Non-JSON / empty / unparseable error body → no envelope to type.
        throw new ConnectionError(
          `IPP error response body was not valid JSON (HTTP ${res.status})`,
          { statusCode: res.status, cause },
        )
      }
      const err = ippErrorFromEnvelope(body, res.status)
      if (err === null) {
        // Body parsed but matches neither accepted envelope shape — also opaque.
        throw new ConnectionError(
          `IPP error response did not contain an error envelope (HTTP ${res.status})`,
          { statusCode: res.status },
        )
      }
      throw err
    }

    let data: unknown
    try {
      data = await res.json()
    } catch (cause) {
      throw new ConnectionError("IPP response body was not valid JSON", { cause })
    }
    // Success bodies (incl. Channel ② {status:"rejected", reject_code}) go
    // through snake→camel so `reject_code` surfaces as `rejectCode`.
    return keysToCamel(data) as T
  }
}
