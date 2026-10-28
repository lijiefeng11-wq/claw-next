import type { EventRecord, StoredMessage, UnknownCheck } from "./journal.js";
import type { ShopRuntime } from "./runtime.js";

/** 原因代码 → 给非技术人员看的中文说明。 */
export const REASONS: Record<string, string> = {
  history_sync: "历史同步/重连回补，不自动处理",
  no_stable_id: "平台未提供可靠消息编号，需人工处理",
  backend_unavailable: "后台未连接",
  platform_logged_out: "平台未登录或登录已失效",
  platform_identity_unverified: "平台店铺身份未核验",
  platform_shop_mismatch: "平台登录的店铺与配置不符（疑似串店）",
  no_platform_session: "没有有效的平台会话",
  lease_busy: "另一台客户端正持有本店发送归属",
  lease_invalid: "发送归属无效或已过期",
  history_fetch_failed: "无法取得对话历史",
  superseded_before_submit: "已有更新消息，本条不单独处理",
  superseded: "已有更新消息或上下文已变化，旧判断失效",
  session_changed: "平台会话已更换，旧任务失效",
  instance_changed: "客户端已重启，旧任务失效",
  context_too_large: "上下文超过 200 条，需扩展协议，已停止自动处理",
  content_too_long: "单条消息超过 8000 字，已停止自动处理",
  body_too_large: "请求超过 256 KiB，需扩展协议，已停止自动处理",
  mode_observe: "仅观察模式，不发送",
  mode_manual: "人工接管中，不发送",
  manual_takeover: "此对话人工接管中",
  history_incomplete: "历史不完整",
  unsupported_content: "最新消息是无法识别的内容",
  decision_expired: "判断已过期",
  reply_deadline_exceeded: "超过回复时限，本条待人工处理；后续新消息继续处理",
  already_attempted: "此事件已有发送尝试",
  conversation_busy: "此对话正有发送进行中",
  claim_expiring: "发送许可即将过期",
  capability_not_confirmed: "后台未确认支持附加发送",
  reply_deadline_withdrawn: "后台已撤回回复时限能力，本条待人工处理；后续新消息继续处理",
  invalid_remaining_budget: "剩余预算格式不被后台接受",
  cancel_owner_mismatch: "取消请求的归属不匹配",
  cancel_not_allowed: "事件已不可取消",
  option_unknown: "要发送的内容不在本次候选中（或客户端已重启）",
  option_type_mismatch: "要发送的内容类型与候选不符",
  option_gone: "要发送的内容已不在当前页面",
  send_options_not_retained: "客户端重启，发送候选未保留",
  confirmed_after_deadline: "超过确认截止才确认，结果不确定",
  promoted_live: "历史中已有的消息收到实时推送，按新消息处理",
  runtime_stopped: "客户端已停止",
  not_reply: "无需发送",
  interrupted_during_send: "发送过程中客户端中断，结果不确定",
  restarted_before_send: "重启前未调用平台发送",
  send_timeout: "平台发送超时，结果不确定",
  send_exception: "平台发送异常，结果不确定",
  platform_ack_without_message_id: "平台只返回了传输确认，没有消息编号",
  platform_message_id_invalid: "平台消息编号无效",
  mock_rejected_before_call: "模拟：发送前被拒绝，未调用平台",
  claim_response_lost: "发送许可响应丢失，未调用平台",
  claim_not_granted: "未取得发送许可",
  token_shop_mismatch: "客户端口令属于其他店铺，已拒绝",
  unauthorized: "口令无效",
  protocol_unsupported: "后台协议版本不受支持",
  network_error: "网络不可达",
  timeout: "请求超时",
  lease_expired: "发送归属已过期",
  lease_mismatch: "发送归属不匹配",
  stale_revision: "上下文版本过旧",
  message_duplicate: "该消息已由其他任务提交",
  event_conflict: "事件编号冲突",
  decision_internal_error: "后台判断出错",
  backend_restarted: "后台重启",
  shop_disabled: "店铺在后台未启用",
  no_matching_rule: "没有匹配的规则",
  message_stale: "消息已超过 2 分钟",
  unknown_delivery: "此对话存在待核查发送",
  settings_changed: "后台设置已更改",
  unsupported_context: "上下文包含图片/卡片等非文本内容",
  empty_message: "消息为空",
  message_future: "消息时间异常（晚于当前时间）",
  superseded_by_newer: "已有更新消息",
  model_not_configured: "后台模型未配置",
  model_request_failed: "后台模型调用失败",
  model_invalid_output: "后台模型返回内容无效",
  model_empty_reply: "后台模型未给出回复",
  model_response_too_large: "后台模型返回过大",
  pdd_adapter_not_implemented: "拼多多收发尚未接入",
  pdd_send_not_implemented: "拼多多发送尚未接入，未调用平台",
};

export function reasonText(code: string | null | undefined): string {
  if (!code) return "";
  if (code.startsWith("unsupported_action:")) return "后台给出客户端不支持的操作，未执行";
  const base = code.startsWith("claim_rejected:") ? code.slice("claim_rejected:".length) : code;
  return REASONS[base] ?? REASONS[code] ?? code;
}

export type Tone = "muted" | "wait" | "suggest" | "handoff" | "ok" | "warn" | "error";
export type MessageStatus = { label: string; tone: Tone; reason: string };

/** 发送结果不确定：状态仍是“待核查”、永不重发；附上前台自动读聊天记录的结论，帮助人工判断是否补发。 */
export function unknownStatus(reason: string, check: UnknownCheck | undefined): MessageStatus {
  const base = reason ? `${reason}。` : "";
  if (check?.result === "seen") return { label: "待核查·记录里已看到", tone: "warn", reason: `${base}自动核对：发送后的聊天记录里已出现这条内容，大概率已发出。不会重发。` };
  if (check?.result === "not_seen") return { label: "待核查·记录里没看到", tone: "error", reason: `${base}自动核对：发送后聊天记录已刷新，但没有这条内容，请到平台确认后人工补发。不会自动重发。` };
  if (check?.result === "unavailable") return { label: "结果待核查", tone: "error", reason: `${base}自动核对：无法确认发送后的聊天记录是否完整覆盖，请到平台聊天记录核查。不会自动重发。` };
  // 尚未核对（核对进行中，或客户端重启后不再核对）：不声称正在核对。
  return { label: "结果待核查", tone: "error", reason: `${base}请到平台聊天记录确认。不会自动重发。` };
}

export function messageStatus(message: StoredMessage, ev: EventRecord | undefined, note: string | undefined): MessageStatus | null {
  if (message.role !== "buyer") return null;
  if (!ev) {
    if (note === "reply_deadline_exceeded") return { label: "本条待人工", tone: "handoff", reason: reasonText(note) };
    if (note === "history_sync") return { label: "历史消息", tone: "muted", reason: reasonText(note) };
    if (note) return { label: "未自动处理", tone: "warn", reason: reasonText(note) };
    return { label: "等待处理", tone: "wait", reason: "" };
  }
  const a = ev.attempt;
  if (a) {
    if (["not_sent", "aborted_before_send", "claim_failed"].includes(a.phase) && a.detail === "reply_deadline_exceeded") return { label: "本条待人工", tone: "handoff", reason: reasonText(a.detail) };
    switch (a.phase) {
      case "sent":
        return { label: "已获平台确认", tone: "ok", reason: a.platform_message_id ? `平台消息 ${a.platform_message_id}` : "" };
      case "unknown":
        return unknownStatus(reasonText(a.detail), ev.check);
      case "not_sent":
      case "aborted_before_send":
      case "claim_failed":
        return { label: "未发送", tone: "warn", reason: reasonText(a.detail) };
      default:
        return { label: "发送中", tone: "wait", reason: "" };
    }
  }
  if (ev.blocked === "reply_deadline_exceeded" && ev.snapshot?.delivery.status !== "unknown") return { label: "本条待人工", tone: "handoff", reason: reasonText(ev.blocked) };
  if (ev.stage === "prepared") return { label: "提交后台中", tone: "wait", reason: "" };
  if (ev.stage === "submit_failed") return { label: "提交失败，待原样补报", tone: "warn", reason: reasonText(ev.error) };
  // 契约 A.2：冻结了预算的请求体在首次受理前遇到能力撤回，后台确定拒绝；不换编号、不删预算重投，本条待人工。
  if (ev.stage === "rejected" && ev.error === "capability_not_confirmed" && ev.budget_ms !== undefined) return { label: "本条待人工", tone: "handoff", reason: reasonText("reply_deadline_withdrawn") };
  if (ev.stage === "rejected") return { label: "后台拒绝", tone: "error", reason: reasonText(ev.error) };
  const s = ev.snapshot;
  if (!s || s.state !== "ready" || !s.decision) return { label: "等待判断", tone: "wait", reason: "" };
  if (s.delivery.status === "unknown") return unknownStatus(reasonText(s.delivery.reason), ev.check);
  switch (s.decision.action) {
    case "reply":
    case "send_item":
      return { label: s.decision.action === "reply" ? "建议回复" : "建议发送", tone: "suggest", reason: ev.blocked ? `未发送：${reasonText(ev.blocked)}` : "" };
    case "handoff":
      return { label: "建议交人工", tone: "handoff", reason: `${reasonText(s.decision.reason)}（仅为建议，平台未执行转接）` };
    case "none":
      return { label: "无需回复", tone: "muted", reason: reasonText(s.decision.reason) };
  }
}

export function shopView(rt: ShopRuntime, now = Date.now() / 1000) {
  const platform = rt.adapter.status();
  const identityOk = !!platform.identity && platform.identity.platform_shop_id === rt.config.platform_shop_id;
  const conversations = [...rt.journal.conversations.values()].map((conv) => {
    const messages = conv.messages.map((m) => {
      const ev = rt.journal.eventForMessage(conv.conversation_id, m.id);
      return {
        id: m.id,
        stable: m.stable,
        role: m.role,
        kind: m.kind,
        content: m.content,
        created_at: m.created_at,
        live: m.live,
        status: messageStatus(m, ev, conv.notes[m.id]),
        decision_text: ev?.snapshot?.decision?.action === "reply" ? ev.snapshot.decision.text : ev ? rt.itemLabel(ev) : null,
        event_id: ev?.event_id ?? null,
        context_revision: ev?.context_revision ?? null,
        history_complete: ev ? ev.history_complete : null,
      };
    });
    return {
      conversation_id: conv.conversation_id,
      revision: conv.revision,
      takeover: conv.takeover,
      unknown: rt.journal.hasUnknown(conv.conversation_id),
      last_at: conv.messages[conv.messages.length - 1]?.created_at ?? 0,
      messages,
    };
  });
  conversations.sort((a, b) => b.last_at - a.last_at);
  return {
    shop_id: rt.config.shop_id,
    display_name: rt.config.display_name,
    adapter: rt.config.adapter,
    simulated: rt.adapter.simulated,
    mode: rt.config.mode,
    instance_id: rt.instanceId,
    session_id: rt.sessionId,
    backend: { state: rt.backendState.state, detail: reasonText(rt.backendState.detail) || rt.backendState.detail, client_id: rt.backendState.me?.client_id ?? null },
    platform: { logged_in: platform.logged_in, identity: platform.identity, detail: platform.detail, identity_ok: identityOk, expected: rt.config.platform_shop_id },
    lease: { state: rt.lease.state, generation: rt.lease.generation, seconds_left: Math.max(0, Math.round(rt.lease.valid_until - now)), detail: reasonText(rt.lease.detail) || rt.lease.detail },
    duplicates: rt.duplicates,
    conversations,
  };
}

export type ShopView = ReturnType<typeof shopView>;
