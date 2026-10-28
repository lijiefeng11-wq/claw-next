import type { AdapterEvent, HistoryLoad, HistoryResult, PlatformMessage, PlatformStatus } from "./adapter.js";
import type { PddIdentity, ParsedList } from "./pddParse.js";

/** 买家消息需在本次平台会话开始之后、且距今不超过该秒数，才算新消息。 */
export const LIVE_WINDOW_SECONDS = 120;

/** segment：最新的一段连续消息编号。新一批与它有重叠才合并；不重叠且更新则另起一段（中间可能漏了消息）；同一秒分不清则清空。 */
type Conversation = { messages: Map<string, PlatformMessage>; complete: boolean; unstable: number; segment: Set<string>; segmentNewest: number };

/**
 * 被动跟踪拼多多客服页面状态：只消费页面自身请求得到的响应，不主动请求平台。
 * - 身份：/chats/userinfo/realtime 与 queryCustomServiceInfo 的店铺编号一致才算核验。
 * - 历史：按买家缓存页面加载过的消息；只有平台表示没有更多历史时才算完整。
 * - 新消息：买家消息、本会话首次出现、时间晚于会话开始且在时间窗内；其余一律按历史同步处理。
 */
export class PddSessionTracker {
  private realtime: PddIdentity | null = null;
  private csInfo: PddIdentity | null = null;
  private active: PddIdentity | null = null;
  private sessionStart = 0;
  private problem: string | null = null;
  private conversations = new Map<string, Conversation>();
  private loadedAt = new Map<string, number>();
  /** 每买家最近 10 次单独加载的明细（每次是一页连续消息）。 */
  private loads = new Map<string, HistoryLoad[]>();

  constructor(
    private readonly emit: (e: AdapterEvent) => void,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  status(windowOpen: boolean): PlatformStatus {
    if (this.active) {
      return {
        logged_in: true,
        identity: { platform_shop_id: this.active.mall_id, display_name: this.active.mall_name },
        detail: "已接入：自动点开未读对话读取新消息；发送经页面操作，以页面发送响应中的平台消息编号确认",
      };
    }
    if (this.problem) return { logged_in: false, identity: null, detail: this.problem };
    return { logged_in: false, identity: null, detail: windowOpen ? "等待登录并进入客服聊天页以核验店铺身份" : "平台窗口未打开" };
  }

  identityFromRealtime(id: PddIdentity) {
    this.realtime = id;
    this.reconcile();
  }

  identityFromCsInfo(id: PddIdentity) {
    this.csInfo = id;
    this.reconcile();
  }

  private reconcile() {
    const r = this.realtime;
    if (!r) return;
    if (this.csInfo && this.csInfo.mall_id !== r.mall_id) {
      this.end("platform_identity_conflict");
      this.problem = "两个平台接口给出的店铺编号不一致，身份未核验";
      this.emit({ type: "status" });
      return;
    }
    if (this.active?.mall_id === r.mall_id) return;
    if (this.active) this.end("platform_identity_changed");
    this.problem = null;
    this.active = r;
    this.sessionStart = this.now();
    this.emit({ type: "session_started" });
    this.emit({ type: "status" });
  }

  /** 平台会话失效（跳到登录页、窗口关闭）。 */
  end(reason: string) {
    this.realtime = null;
    this.csInfo = null;
    this.conversations.clear();
    this.loadedAt.clear();
    this.loads.clear();
    if (!this.active) return;
    this.active = null;
    this.emit({ type: "session_ended", reason });
    this.emit({ type: "status" });
  }

  chatList(list: ParsedList) {
    if (!this.active) return;
    let conv = this.conversations.get(list.buyer_uid);
    if (!conv) {
      conv = { messages: new Map(), complete: false, unstable: 0, segment: new Set(), segmentNewest: -Infinity };
      this.conversations.set(list.buyer_uid, conv);
    }
    this.loadedAt.set(list.buyer_uid, this.now());
    const batch = this.loads.get(list.buyer_uid) ?? [];
    batch.push({
      at: this.now() * 1000,
      ids: list.messages.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : [])),
      newest: Math.max(-Infinity, ...list.messages.map((m) => m.created_at)),
      dropped: list.skipped + list.messages.filter((m) => !m.platform_message_id).length,
    });
    this.loads.set(list.buyer_uid, batch.slice(-10));
    if (!list.has_more) conv.complete = true;
    conv.unstable += list.skipped;
    const ids = list.messages.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : []));
    const newest = Math.max(-Infinity, ...list.messages.map((m) => m.created_at));
    if (ids.length) {
      if (conv.segment.size && ids.some((id) => conv.segment.has(id))) {
        for (const id of ids) conv.segment.add(id);
        conv.segmentNewest = Math.max(conv.segmentNewest, newest);
      } else if (newest > conv.segmentNewest) {
        conv.segment = new Set(ids);
        conv.segmentNewest = newest;
      } else if (newest === conv.segmentNewest) {
        // 平台时间只到秒：不相连的两批最新时间相同，分不清哪批更新，清空最新段，不再据此判断接续。
        conv.segment = new Set();
      }
    }
    const fresh: PlatformMessage[] = [];
    for (const m of list.messages) {
      if (!m.platform_message_id) {
        conv.unstable += 1;
        continue;
      }
      if (conv.messages.has(m.platform_message_id)) continue;
      conv.messages.set(m.platform_message_id, m);
      fresh.push(m);
    }
    const now = this.now();
    for (const m of fresh) {
      const live = m.role === "buyer" && m.created_at >= this.sessionStart && now - m.created_at <= LIVE_WINDOW_SECONDS;
      this.emit({ type: "message", message: m, live });
    }
  }

  knownConversations(): string[] {
    return [...this.conversations.keys()];
  }

  historyLoads(conversationId: string): HistoryLoad[] {
    return [...(this.loads.get(conversationId) ?? [])];
  }

  /** 页面最近一次加载该买家对话的时间（秒）；未加载为 0。 */
  lastLoadedAt(conversationId: string): number {
    return this.loadedAt.get(conversationId) ?? 0;
  }

  history(conversationId: string): HistoryResult {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error("pdd_history_not_loaded");
    const messages = [...conv.messages.values()].sort((a, b) => a.created_at - b.created_at);
    const gap = !conv.complete ? "pdd_history_has_more" : conv.unstable ? "pdd_unparsed_messages" : null;
    return { messages, complete: gap === null, gap_reason: gap, ...(!conv.complete && !conv.unstable ? { latest_segment: [...conv.segment] } : {}) };
  }
}
