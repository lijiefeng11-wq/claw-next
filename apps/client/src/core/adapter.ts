import type { Card, ImageMime, Kind, MarkColor, PageObserved, Role } from "./protocol.js";
import type { PlatformOrder } from "./pddOrders.js";
import type { PageHealthView } from "./pageHealth.js";

export type PlatformIdentity = { platform_shop_id: string; display_name: string };

export type PlatformStatus = {
  logged_in: boolean;
  /** 平台实际登录身份；null 表示未核验。 */
  identity: PlatformIdentity | null;
  /** 给用户看的状态说明，例如登录失效原因。 */
  detail: string;
  /** 平台页面生命周期状态（仅真实平台页面存在时提供）。 */
  page?: PageHealthView;
  /** 平台页面导航状态（仅真实平台页面存在时提供）：是否停在会话页、能否后退。 */
  nav?: PlatformNav;
};

export type PlatformNav = { on_chat: boolean; can_go_back: boolean };
/** 人工导航平台页面：back 后退一步，chat 回到会话页。 */
export type PlatformNavAction = "back" | "chat";

export type PlatformMessage = {
  conversation_id: string;
  /** 平台稳定消息 ID；没有可靠 ID 时为 null，不得用随机值替代后提交。 */
  platform_message_id: string | null;
  role: Role;
  kind: Kind;
  content: string;
  created_at: number;
  /** 卡片的结构化可读信息（纯文本，不含网址）。 */
  card?: Card;
  /** 平台图片地址；仅本机用于取图，不提交后台。 */
  image_ref?: string;
};

export type HistoryLoad = { at: number; ids: string[]; newest: number; dropped: number };

export type ImageFetchResult = { ok: true; mime: ImageMime; bytes: Buffer } | { ok: false; reason: string };

export type HistoryResult = {
  messages: PlatformMessage[];
  /** 平台能证明已取得全部历史时才为 true。 */
  complete: boolean;
  gap_reason: string | null;
  /**
   * complete=false 时，页面最近加载的、能证明首尾相连的最新一段消息编号；本地已确认完整的那条在其中，才可拼接。
   * 有解析不了的消息时不提供。
   */
  latest_segment?: string[];
};

/** deadline：许可内发送确认截止（秒）；recheck 在真正点击前执行，非空则返回 not_sent。 */
export type SendRequest = { conversation_id: string; text: string; attempt_id: string; deadline?: number; recheck?: () => string | null };

/**
 * confirmed：平台明确确认并给出平台消息 ID。
 * not_sent：确定没有向平台发出请求。
 * unknown：请求已开始但结果无法确认（超时、断线、回执缺失）。
 */
export type SendResult =
  | { status: "confirmed"; platform_message_id: string }
  | { status: "not_sent"; reason: string }
  | { status: "unknown"; reason: string };

/**
 * 页面上可发送的已有内容（契约“聊天页附加发送”）。key 是适配器私有的对象身份
 * （说明书含模板编号与版本），只在本机内存中使用，不上传、不写日志。
 */
export type PlatformSendOption =
  | { type: "instruction"; key: string; goods_title: string; name: string; observed_at: number }
  | { type: "goods_card"; key: string; goods_title: string; observed_at: number }
  | { type: "video"; key: string; name: string; duration?: number; observed_at: number };

/**
 * deadline：确认截止（本机时钟，秒），过了就不能再点发送，也不能再认定 confirmed。
 * recheck：真正点击发送前调用；返回非空即阻止原因，适配器须放弃点击并返回 not_sent。
 */
export type SendItemRequest = { conversation_id: string; option: PlatformSendOption; attempt_id: string; deadline: number; recheck: () => string | null };

/**
 * 契约“标星执行与成功判据”。deadline：确认截止（本机时钟，秒），过了不能再点击，也不能再认定成功。
 * recheck：真正点击那一刻调用；返回非空即阻止原因，适配器须放弃点击并返回 not_sent。
 */
export type MarkRequest = { conversation_id: string; color: MarkColor; attempt_id: string; deadline: number; recheck: () => string | null };

/**
 * confirmed：成功判据全部满足。
 * not_sent：点击前放弃；reason 为契约页面原因（conv_state_changed / conv_state_unavailable）或运行时阻止原因，由运行时归类。
 * unknown：已开始点击但不能确认；不重试、不补做。
 * page_observed：点击后读一次星标，只供显示，不参与判定。
 */
export type MarkResult =
  | { status: "confirmed"; page_observed: PageObserved }
  | { status: "not_sent"; reason: string }
  | { status: "unknown"; reason: string; page_observed?: PageObserved };

export type AdapterEvent =
  | { type: "status" }
  /** 平台会话建立或重新登录：运行时必须换新 session_id。 */
  | { type: "session_started" }
  | { type: "session_ended"; reason: string }
  /** live=false 表示历史同步/重连回补，不当作新消息自动处理。 */
  | { type: "message"; message: PlatformMessage; live: boolean }
  /** 该买家当前读到的全部订单摘要（整表替换）；只按读取请求所属买家归属。 */
  | { type: "orders"; conversation_id: string; orders: PlatformOrder[] }
  /** 该买家对话当前可发送的已有内容（整表替换）。 */
  | { type: "send_options"; conversation_id: string; options: PlatformSendOption[] };

export interface PlatformAdapter {
  readonly kind: "mock" | "pdd";
  readonly simulated: boolean;
  status(): PlatformStatus;
  login(): Promise<void>;
  logout(): Promise<void>;
  fetchHistory(conversationId: string): Promise<HistoryResult>;
  send(request: SendRequest): Promise<SendResult>;
  /** 在本店已登录的平台会话中读取买家图片原文件；只允许平台图片域名。 */
  fetchImage?(ref: string): Promise<ImageFetchResult>;
  /** 等该买家进行中的订单读取结束（最多 timeoutMs），避免订单晚到使刚生成的决定作废。 */
  ordersSettled?(conversationId: string, timeoutMs: number): Promise<void>;
  /**
   * 只读当前页面上该买家会话的收藏状态（不点击、不悬停）。读数须来自该买家正是唯一打开的会话、
   * 且读取前后页面代次未变；否则 marked 为 null。颜色未可靠读到时为 null。
   */
  readConvState?(conversationId: string, timeoutMs: number): Promise<{ marked: boolean | null; color: MarkColor | null }>;
  /**
   * 契约“标星执行与成功判据”：在该买家会话上只点星标颜色浮层中的目标颜色项（不点星标本身、不取消收藏）。
   * 点击前核对页面代次、唯一打开的会话、星标未收藏与浮层归属；点击窗口内只放行一条与本次一致的标星请求，
   * 按该请求自己的响应判定。只有成功判据全部满足才返回 confirmed。
   */
  markConversation?(request: MarkRequest): Promise<MarkResult>;
  /**
   * 通过平台页面自身按钮发送一项已有内容。只有平台明确成功且聊天记录相对点击前恰好新增一条
   * 对应对象的客服消息时才返回 confirmed（附该消息编号）；点击前放弃返回 not_sent；其余 unknown。
   */
  sendItem?(request: SendItemRequest): Promise<SendResult>;
  /** 自动模式且附加发送能力已确认时调用：让页面加载可发送内容的候选（只做界面操作，不发送）。 */
  prepareSendOptions?(): Promise<void>;
  /**
   * 同上条件，提交前调用：让页面加载该买家可发的说明书与“商品推荐”页签的商品（只做界面操作，不发送），
   * 并等该买家进行中的订单读取结束（此时运行时不再另调 ordersSettled）。timeoutMs 是准备阶段剩余预算，超时就返回，读不完的省略。
   */
  sendOptionsSettled?(conversationId: string, timeoutMs: number): Promise<void>;
  /** 人工重新加载平台页面；返回阻止原因，成功为 null。 */
  reloadPage?(): string | null;
  /** 人工导航平台页面（后退一步 / 回到会话页）；返回阻止原因，成功为 null。发送进行中不导航。 */
  navigatePlatform?(action: PlatformNavAction): string | null;
  /** 人工“清理弹窗”：关闭平台页面上的引导 / 广告浮层（不发送、不碰聊天输入区）。返回关闭个数或阻止原因。 */
  dismissPopups?(): Promise<{ dismissed: number } | { blocked: string }>;
  /**
   * 预热（同上条件）：该买家没有进行中的处理时调用，在后台补齐下一条消息要用的候选（只做界面操作，不发送）。
   * 必须可被发送与准备抢占：它们开始前先让预热在下一步之间停下，而不是以“忙”拒绝。
   */
  warmConversation?(conversationId: string): Promise<void>;
  /** 页面最近一次从平台加载该买家聊天记录的本机时间（毫秒）；未加载为 0。用于判断发送结果不确定之后记录是否刷新过。 */
  historyLoadedAt?(conversationId: string): number;
  /**
   * 该买家最近几次单独的聊天记录加载（每次是平台返回的一页连续消息）：本机加载时间（毫秒）、这一页的消息编号、
   * 最新消息的平台时间（秒）与被丢弃的条数。只用于证明某次加载覆盖了发送前后的连续区间。
   */
  historyLoads?(conversationId: string): HistoryLoad[];
  onEvent(listener: (event: AdapterEvent) => void): void;
  dispose(): void;
}
