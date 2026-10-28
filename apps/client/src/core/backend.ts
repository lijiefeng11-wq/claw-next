import {
  EventSnapshot,
  Lease,
  MAX_BODY_BYTES,
  Me,
  ReceiptStatus,
  normalizeBackendUrl,
  parseHealth,
  parseLease,
  parseMe,
  parseSnapshot,
} from "./protocol.js";

/** 后台返回的明确错误（有 HTTP 状态与错误码）。 */
export class BackendError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`${status} ${code}`);
  }
}

/** 网络失败、超时或响应不可解析：请求结果不确定。 */
export class TransportError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type FetchLike = typeof fetch;

export class BackendClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 8000) {
    this.base = normalizeBackendUrl(baseUrl);
  }

  private async request(method: string, path: string, body?: string, auth = true): Promise<unknown> {
    if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new BackendError(413, "body_too_large_local");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body,
        // 口令不能随重定向转发到其他地址。
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TransportError((err as Error)?.name === "TimeoutError" ? "timeout" : "network_error");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw response.ok ? new TransportError("response_unreadable") : new BackendError(response.status, "http_" + response.status);
    }
    if (!response.ok) {
      const code = (parsed as { error?: { code?: unknown } })?.error?.code;
      throw new BackendError(response.status, typeof code === "string" ? code : "http_" + response.status);
    }
    return parsed;
  }

  async health() {
    return parseHealth(await this.request("GET", "/health", undefined, false));
  }

  async me(): Promise<Me> {
    return parseMe(await this.request("GET", "/api/v1/me"));
  }

  async heartbeat(instance_id: string, session_id: string, capabilities: string[] = []): Promise<Lease> {
    const body = capabilities.length ? { instance_id, session_id, capabilities } : { instance_id, session_id };
    return parseLease(await this.request("POST", "/api/v1/heartbeat", JSON.stringify(body)));
  }

  /** body 必须是本地已持久化的原始请求体；重投时逐字节相同。 */
  async submitEvent(body: string): Promise<EventSnapshot> {
    return parseSnapshot(await this.request("POST", "/api/v1/events", body));
  }

  async getEvent(eventId: string): Promise<EventSnapshot> {
    return parseSnapshot(await this.request("GET", `/api/v1/events/${encodeURIComponent(eventId)}`));
  }

  async claim(eventId: string, owner: { instance_id: string; session_id: string; generation: number }, attempt_id: string): Promise<EventSnapshot> {
    const body = JSON.stringify({ ...owner, attempt_id });
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/claim`, body));
  }

  /** 契约 A.5：只放弃自己的未领取事件；重试必须原样使用同一四字段。 */
  async cancel(eventId: string, owner: { instance_id: string; session_id: string; generation: number }): Promise<EventSnapshot> {
    const body = JSON.stringify({ instance_id: owner.instance_id, session_id: owner.session_id, generation: owner.generation, reason: "reply_deadline_exceeded" });
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/cancel`, body));
  }

  async receipt(eventId: string, attempt_id: string, status: ReceiptStatus, platform_message_id?: string): Promise<EventSnapshot> {
    const payload: Record<string, string> = { attempt_id, status };
    if (status === "sent" && platform_message_id) payload.platform_message_id = platform_message_id;
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/receipt`, JSON.stringify(payload)));
  }
}
