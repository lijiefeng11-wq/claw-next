import { randomUUID } from "node:crypto";
import type { AdapterEvent, HistoryLoad, HistoryResult, ImageFetchResult, PlatformAdapter, PlatformMessage, PlatformSendOption, PlatformStatus, SendItemRequest, SendRequest, SendResult } from "./adapter.js";
import type { Card, Kind } from "./protocol.js";
import type { PlatformOrder } from "./pddOrders.js";

export type MockSendBehavior = "confirm" | "fail_before_call" | "timeout_after_call" | "ack_without_id";

export const MOCK_SEND_BEHAVIORS: readonly MockSendBehavior[] = ["confirm", "fail_before_call", "timeout_after_call", "ack_without_id"];

export type MockOptions = {
  platformShopId: string;
  displayName: string;
  now?: () => number;
};

/**
 * 模拟平台：只产生虚构店铺与虚构消息，用于联调与测试，不连接任何真实平台。
 */
export class MockPlatformAdapter implements PlatformAdapter {
  readonly kind = "mock" as const;
  readonly simulated = true;
  sendBehavior: MockSendBehavior = "confirm";
  /** 模拟“登录成另一家店”，用于验证串店拦截。 */
  loginAs: string | null = null;
  readonly historyGaps = new Set<string>();
  /** 模拟页面只加载最近 N 条（更早的历史“还有更多”）。 */
  readonly historyWindows = new Map<string, number>();
  /** 实际“到达平台”的发送记录，测试用来核对是否重复发送。 */
  readonly platformSends: SendRequest[] = [];
  private loggedIn = false;
  private detail = "未登录（模拟）";
  private readonly history = new Map<string, PlatformMessage[]>();
  private readonly listeners: ((e: AdapterEvent) => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly options: MockOptions) {
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  /** 模拟页面读到某买家的订单（整表替换）。pendingOrders 中的买家视为订单读取进行中。 */
  readonly pendingOrders = new Set<string>();
  injectOrders(conversationId: string, orders: PlatformOrder[]) {
    this.pendingOrders.delete(conversationId);
    this.emit({ type: "orders", conversation_id: conversationId, orders });
  }

  async ordersSettled(conversationId: string, timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    while (this.pendingOrders.has(conversationId) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }

  readonly sendOptionsSettledCalls: string[] = [];
  async sendOptionsSettled(conversationId: string, timeoutMs = 0) {
    this.sendOptionsSettledCalls.push(conversationId);
    await this.ordersSettled(conversationId, timeoutMs);
  }

  /** 记录预热调用（虚构平台无界面操作）。 */
  readonly warmCalls: string[] = [];
  async warmConversation(conversationId: string) {
    this.warmCalls.push(conversationId);
  }

  private emit(event: AdapterEvent) {
    for (const l of this.listeners) l(event);
  }

  onEvent(listener: (e: AdapterEvent) => void) {
    this.listeners.push(listener);
  }

  status(): PlatformStatus {
    if (!this.loggedIn) return { logged_in: false, identity: null, detail: this.detail };
    const id = this.loginAs ?? this.options.platformShopId;
    return { logged_in: true, identity: { platform_shop_id: id, display_name: `${this.options.displayName}（模拟）` }, detail: "已登录（模拟平台）" };
  }

  async login() {
    this.loggedIn = true;
    this.detail = "已登录（模拟平台）";
    this.emit({ type: "session_started" });
    this.emit({ type: "status" });
  }

  async logout() {
    this.expire("已退出登录（模拟）");
  }

  /** 模拟平台登录失效。 */
  expire(reason = "登录已失效（模拟）") {
    if (!this.loggedIn) return;
    this.loggedIn = false;
    this.detail = reason;
    this.emit({ type: "session_ended", reason });
    this.emit({ type: "status" });
  }

  private push(message: PlatformMessage) {
    const list = this.history.get(message.conversation_id) ?? [];
    list.push(message);
    this.history.set(message.conversation_id, list);
  }

  /** 模拟买家发来新消息。stableId=false 模拟平台没有提供可靠消息 ID。 */
  injectBuyerMessage(input: { conversation_id: string; content: string; kind?: Kind; stableId?: boolean; platform_message_id?: string; image_ref?: string; card?: Card }): PlatformMessage {
    const message: PlatformMessage = {
      conversation_id: input.conversation_id,
      platform_message_id: input.stableId === false ? null : input.platform_message_id ?? `mock-m-${randomUUID().slice(0, 12)}`,
      role: "buyer",
      kind: input.kind ?? "text",
      content: input.content,
      created_at: this.now(),
      ...(input.image_ref ? { image_ref: input.image_ref } : {}),
      ...(input.card ? { card: input.card } : {}),
    };
    this.push(message);
    if (this.loggedIn) this.emit({ type: "message", message, live: true });
    return message;
  }

  /** 模拟只进入平台历史、尚未推送的买家消息（随后可用 redeliver 推送）。 */
  seedBuyerHistory(conversation_id: string, content: string): PlatformMessage {
    const message: PlatformMessage = { conversation_id, platform_message_id: `mock-m-${randomUUID().slice(0, 12)}`, role: "buyer", kind: "text", content, created_at: this.now() };
    this.push(message);
    return message;
  }

  /** 模拟同一条消息被平台重复推送。 */
  redeliver(message: PlatformMessage) {
    if (this.loggedIn) this.emit({ type: "message", message, live: true });
  }

  /** 模拟人工在平台后台直接回复买家。 */
  injectAgentReply(conversation_id: string, content: string) {
    const message: PlatformMessage = { conversation_id, platform_message_id: `mock-a-${randomUUID().slice(0, 12)}`, role: "agent", kind: "text", content, created_at: this.now() };
    this.push(message);
    if (this.loggedIn) this.emit({ type: "message", message, live: true });
  }

  /** 模拟断线重连后的历史回补：所有消息以 live=false 重新到达。 */
  replayHistory() {
    if (!this.loggedIn) return;
    for (const list of this.history.values()) for (const message of list) this.emit({ type: "message", message, live: false });
  }

  async fetchHistory(conversationId: string): Promise<HistoryResult> {
    if (!this.loggedIn) throw new Error("not_logged_in");
    const messages = [...(this.history.get(conversationId) ?? [])];
    const window = this.historyWindows.get(conversationId);
    if (window !== undefined) {
      const recent = messages.slice(-window);
      return { messages: recent, complete: false, gap_reason: "模拟：只加载最近一段", latest_segment: recent.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : [])) };
    }
    const gap = this.historyGaps.has(conversationId);
    return { messages: gap ? messages.slice(-1) : messages, complete: !gap, gap_reason: gap ? "模拟：平台历史缺页" : null };
  }

  /** 测试用：聊天记录最近加载时间（毫秒）；null 表示总是刚刚加载过。 */
  historyLoadedAtMs: number | null = null;
  historyLoadedAt(_conversationId: string): number {
    return this.historyLoadedAtMs ?? Date.now();
  }

  /** 测试用：覆盖 historyLoads 的返回；null 时把整份模拟记录当作刚加载的一页（无丢弃）。 */
  historyLoadsOverride: HistoryLoad[] | null = null;
  historyLoads(conversationId: string): HistoryLoad[] {
    if (this.historyLoadsOverride) return this.historyLoadsOverride;
    const list = this.history.get(conversationId) ?? [];
    return [{ at: this.historyLoadedAt(conversationId), ids: list.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : [])), newest: Math.max(-Infinity, ...list.map((m) => m.created_at)), dropped: 0 }];
  }

  /** 测试用：把一条消息放进该买家的平台聊天记录（不推送实时消息），用于构造发送之后的时间点。 */
  addHistoryMessage(message: PlatformMessage) {
    this.push(message);
  }

  /** 测试用：把一条客服消息放进该买家的平台聊天记录（不推送实时消息）。 */
  addAgentHistory(conversationId: string, content: string, kind: Kind = "text") {
    const message: PlatformMessage = { conversation_id: conversationId, platform_message_id: `mock-h-${randomUUID().slice(0, 12)}`, role: "agent", kind, content, created_at: this.now() };
    this.push(message);
    return message;
  }

  /** 测试用：图片地址 → 取图结果；未登记的地址视为取不到。 */
  readonly images = new Map<string, ImageFetchResult>();

  async fetchImage(ref: string): Promise<ImageFetchResult> {
    return this.images.get(ref) ?? { ok: false, reason: "image_fetch_failed" };
  }

  async send(request: SendRequest): Promise<SendResult> {
    const blocked = request.recheck?.();
    if (blocked) return { status: "not_sent", reason: blocked };
    if (!this.loggedIn) return { status: "not_sent", reason: "platform_not_logged_in" };
    switch (this.sendBehavior) {
      case "fail_before_call":
        return { status: "not_sent", reason: "mock_rejected_before_call" };
      case "timeout_after_call":
        this.platformSends.push(request);
        return new Promise<SendResult>(() => undefined);
      case "ack_without_id":
        this.platformSends.push(request);
        return { status: "unknown", reason: "platform_ack_without_message_id" };
      case "confirm": {
        this.platformSends.push(request);
        const id = `mock-p-${randomUUID().slice(0, 12)}`;
        const message: PlatformMessage = { conversation_id: request.conversation_id, platform_message_id: id, role: "agent", kind: "text", content: request.text, created_at: this.now() };
        this.push(message);
        queueMicrotask(() => this.emit({ type: "message", message, live: true }));
        return { status: "confirmed", platform_message_id: id };
      }
    }
  }

  /** 附加发送的模拟结果：confirm 新增一条对应客服消息；timeout_after_click 点击后无结果；ambiguous 同时出现两条同类消息。 */
  itemBehavior: "confirm" | "timeout_after_click" | "ambiguous" = "confirm";
  /** 实际“点击发送”的附加发送记录。 */
  readonly platformItemSends: SendItemRequest[] = [];
  /** 测试用：模拟打开对话框/切换列表期间发生的事（如来新消息）。 */
  beforeItemClick: (() => void | Promise<void>) | null = null;

  /** 模拟页面读到该买家可发送的已有内容（整表替换）。 */
  injectSendOptions(conversationId: string, options: PlatformSendOption[]) {
    this.emit({ type: "send_options", conversation_id: conversationId, options });
  }

  prepareCalls = 0;
  async prepareSendOptions(): Promise<void> {
    this.prepareCalls += 1;
  }

  async sendItem(request: SendItemRequest): Promise<SendResult> {
    if (!this.loggedIn) return { status: "not_sent", reason: "platform_not_logged_in" };
    if (this.beforeItemClick) await this.beforeItemClick();
    const blocked = request.recheck();
    if (blocked) return { status: "not_sent", reason: blocked };
    if (Date.now() / 1000 >= request.deadline) return { status: "not_sent", reason: "claim_expiring" };
    this.platformItemSends.push(request);
    if (this.itemBehavior === "timeout_after_click") return new Promise<SendResult>(() => undefined);
    const card = (): PlatformMessage => ({ conversation_id: request.conversation_id, platform_message_id: `mock-p-${randomUUID().slice(0, 12)}`, role: "agent", kind: "card", content: `[${request.option.type}]`, created_at: this.now() });
    const sent = [card(), ...(this.itemBehavior === "ambiguous" ? [card()] : [])];
    for (const message of sent) {
      this.push(message);
      queueMicrotask(() => this.emit({ type: "message", message, live: true }));
    }
    if (sent.length !== 1) return { status: "unknown", reason: "receipt_ambiguous" };
    return { status: "confirmed", platform_message_id: sent[0].platform_message_id as string };
  }

  dispose() {
    this.listeners.length = 0;
  }
}
