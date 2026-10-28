import type { FetchLike } from "../src/core/backend.js";

/**
 * 契约 A（回复时限）的虚构后台：只在内存，只服务一个虚构店铺，用于“新前台 / 新后台”组合测试。
 * 仅实现前台用到的接口与契约 A 的规则；判断结果由测试控制（hold 时保持 pending）。全部为虚构数据。
 */
type Owner = { instance_id: string; session_id: string; generation: number };
type FakeEvent = {
  raw: string;
  owner: Owner;
  conversation_id: string;
  message_id: string;
  context_revision: number;
  budget: number | null;
  deadline: number | null;
  state: "pending" | "processing" | "ready";
  decision: { action: string; text: string; reason: string; expires_at: number } | null;
  delivery: { status: string; attempt_id: string | null; platform_message_id: string | null; claim_expires_at?: number };
  created_at: number;
};

const SHOP = "shop-a";
const CLIENT = "client-a";

export class FakeDeadlineBackend {
  readonly url = "http://127.0.0.1:9";
  /** 服务端支持的能力；测试可随时修改，影响之后的心跳。 */
  supported = new Set<string>(["reply_deadline"]);
  /** 当前租约确认的能力；测试可直接改写以模拟“请求体冻结后、首次受理前撤回能力”。 */
  leaseCaps: string[] = [];
  /** true 时新事件保持 pending，直到 release。 */
  hold = false;
  replyText = "演示：营业时间请咨询人工客服。";
  /** 快照里附带的 timing（原样返回，用于前台宽容解析测试）。 */
  timing: unknown = undefined;
  readonly requests: { method: string; path: string; body: string | undefined }[] = [];
  readonly events = new Map<string, FakeEvent>();
  private lease: (Owner & { expires_at: number }) | null = null;
  private generation = 0;

  readonly fetch: FetchLike = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.requests.push({ method, path: url.pathname, body });
    const [status, payload] = this.route(method, url.pathname, body);
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as FetchLike;

  private now() {
    return Date.now() / 1000;
  }

  cancelRequests() {
    return this.requests.filter((r) => r.method === "POST" && r.path.endsWith("/cancel"));
  }

  submitRequests() {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/events");
  }

  /** 模拟旧租约到期（进程退出后不再续租）。 */
  expireLease() {
    if (this.lease) this.lease.expires_at = this.now() - 1;
  }

  /** 让 hold 中的事件得出回复决定。 */
  release(eventId: string) {
    const ev = this.events.get(eventId);
    if (ev && ev.state !== "ready") this.decide(ev);
  }

  /** 把后台截止拨到过去（模拟后台预算到期）。 */
  forceExpire(eventId: string) {
    const ev = this.events.get(eventId);
    if (ev && ev.deadline !== null) ev.deadline = this.now() - 1;
  }

  private decide(ev: FakeEvent) {
    ev.state = "ready";
    ev.decision = { action: "reply", text: this.replyText, reason: "rule:hours", expires_at: this.now() + 60 };
  }

  private terminate(ev: FakeEvent) {
    ev.state = "ready";
    ev.decision = { action: "handoff", text: "", reason: "reply_deadline_exceeded", expires_at: this.now() };
  }

  private deadlineTerminal(ev: FakeEvent) {
    return ev.state === "ready" && ev.decision?.action === "handoff" && ev.decision.reason === "reply_deadline_exceeded" && ev.delivery.attempt_id === null;
  }

  /** 契约 A.4：到期且尚无 attempt 的 pending/processing/可发送 ready 事件原子结束。 */
  private checkDeadline(ev: FakeEvent) {
    if (ev.deadline === null || ev.delivery.attempt_id !== null || this.now() < ev.deadline) return;
    if (ev.state !== "ready" || ev.decision?.action === "reply") this.terminate(ev);
  }

  private leaseValid(o: Owner) {
    const l = this.lease;
    return !!l && l.instance_id === o.instance_id && l.session_id === o.session_id && l.generation === o.generation && l.expires_at > this.now();
  }

  private snapshot(id: string, ev: FakeEvent) {
    return {
      event_id: id,
      shop_id: SHOP,
      client_id: CLIENT,
      conversation_id: ev.conversation_id,
      message_id: ev.message_id,
      context_revision: ev.context_revision,
      session_id: ev.owner.session_id,
      generation: ev.owner.generation,
      state: ev.state,
      decision: ev.decision,
      delivery: ev.delivery,
      created_at: ev.created_at,
      ...(ev.deadline !== null ? { event_deadline: ev.deadline } : {}),
      ...(ev.state === "ready" && this.timing !== undefined ? { timing: this.timing } : {}),
    };
  }

  private route(method: string, path: string, body: string | undefined): [number, unknown] {
    const err = (status: number, code: string): [number, unknown] => [status, { error: { code } }];
    if (method === "GET" && path === "/health") return [200, { service: "claw-next", status: "ok", protocol_version: "1.0" }];
    if (method === "GET" && path === "/api/v1/me") return [200, { role: "client", client_id: CLIENT, shop_id: SHOP, protocol_version: "1.0" }];
    const p = body ? (JSON.parse(body) as Record<string, any>) : {};
    if (method === "POST" && path === "/api/v1/heartbeat") {
      const l = this.lease;
      if (l && l.expires_at > this.now() && l.instance_id !== p.instance_id) return err(409, "lease_busy");
      if (!l || l.instance_id !== p.instance_id || l.session_id !== p.session_id) this.generation += 1;
      this.lease = { instance_id: p.instance_id, session_id: p.session_id, generation: this.generation, expires_at: this.now() + 60 };
      const requested: string[] = Array.isArray(p.capabilities) ? p.capabilities : [];
      this.leaseCaps = requested.filter((c) => this.supported.has(c));
      return [200, { shop_id: SHOP, client_id: CLIENT, ...this.lease, capabilities: this.leaseCaps }];
    }
    if (method === "POST" && path === "/api/v1/events") {
      const existing = this.events.get(p.event_id);
      // 原样重投返回原记录，不重新判断能力/租约；不同请求体为冲突。
      if (existing) return existing.raw === body ? [202, this.snapshot(p.event_id, existing)] : err(409, "event_conflict");
      const owner = { instance_id: p.instance_id, session_id: p.session_id, generation: p.generation };
      let budget: number | null = null;
      if ("remaining_budget_ms" in p) {
        if (!this.leaseValid(owner) || !this.leaseCaps.includes("reply_deadline")) return err(400, "capability_not_confirmed");
        const b = p.remaining_budget_ms;
        if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 20000) return err(400, "invalid_remaining_budget");
        budget = b;
      }
      if (!this.leaseValid(owner)) return err(409, "lease_mismatch");
      const ev: FakeEvent = {
        raw: body as string,
        owner,
        conversation_id: p.conversation_id,
        message_id: p.message_id,
        context_revision: p.context_revision,
        budget,
        deadline: budget === null ? null : this.now() + budget / 1000,
        state: "pending",
        decision: null,
        delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null },
        created_at: this.now(),
      };
      if (budget === 0) this.terminate(ev);
      else if (!this.hold) this.decide(ev);
      this.events.set(p.event_id, ev);
      return [202, this.snapshot(p.event_id, ev)];
    }
    const m = /^\/api\/v1\/events\/([^/]+)(?:\/(claim|receipt|cancel))?$/.exec(path);
    const id = m ? decodeURIComponent(m[1]) : "";
    const ev = this.events.get(id);
    if (!m || !ev) return err(404, "not_found");
    this.checkDeadline(ev);
    const action = m[2];
    if (!action && method === "GET") return [200, this.snapshot(id, ev)];
    if (action === "claim") {
      if (this.deadlineTerminal(ev)) return err(409, "reply_deadline_exceeded");
      if (ev.delivery.attempt_id) return ev.delivery.attempt_id === p.attempt_id ? [200, this.snapshot(id, ev)] : err(409, "already_claimed");
      if (!this.leaseValid(p as Owner)) return err(409, "lease_mismatch");
      if (ev.state !== "ready" || ev.decision?.action !== "reply") return err(409, "not_claimable");
      ev.delivery = { status: "claimed", attempt_id: p.attempt_id, platform_message_id: null, claim_expires_at: this.now() + 10 };
      return [200, this.snapshot(id, ev)];
    }
    if (action === "receipt") {
      if (ev.delivery.attempt_id !== p.attempt_id) return err(409, "attempt_mismatch");
      ev.delivery = { status: p.status, attempt_id: p.attempt_id, platform_message_id: p.platform_message_id ?? null };
      return [200, this.snapshot(id, ev)];
    }
    if (action === "cancel") {
      const keys = Object.keys(p).sort().join(",");
      if (keys !== "generation,instance_id,reason,session_id" || p.reason !== "reply_deadline_exceeded") return err(400, "invalid_request");
      const o = ev.owner;
      if (o.instance_id !== p.instance_id || o.session_id !== p.session_id || o.generation !== p.generation) return err(409, "cancel_owner_mismatch");
      if (this.deadlineTerminal(ev)) return [200, this.snapshot(id, ev)];
      if (!this.leaseCaps.includes("reply_deadline")) return err(409, "capability_not_confirmed");
      if (!this.leaseValid(o)) return err(409, "lease_mismatch");
      if (ev.delivery.attempt_id !== null || (ev.state === "ready" && ev.decision?.action !== "reply")) return err(409, "cancel_not_allowed");
      this.terminate(ev);
      return [200, this.snapshot(id, ev)];
    }
    return err(405, "method_not_allowed");
  }
}
