import { MOCK_SEND_BEHAVIORS, MockSendBehavior } from "./mockAdapter.js";
import { isIdentifier, normalizeBackendUrl, ProtocolError } from "./protocol.js";
import { isPathSafeShopId } from "./security.js";
import { SHOP_MODES, ShopMode } from "./runtime.js";

/** 渲染页面可调用的全部动作。未列出的通道一律拒绝。 */
export const IPC_CHANNELS = [
  "state:get",
  "workspace:present",
  "shop:save",
  "shop:remove",
  "shop:setToken",
  "shop:connect",
  "shop:disconnect",
  "shop:login",
  "shop:logout",
  "shop:reloadPage",
  "shop:dismissPopups",
  "shop:platformNav",
  "shop:setMode",
  "app:setStartup",
  "conv:takeover",
  "sim:message",
  "sim:action",
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

export const SIM_ACTIONS = ["set_send_behavior", "toggle_history_gap", "login_as_other", "login_as_expected", "expire_login", "replay_history", "redeliver_last", "agent_reply"] as const;
export type SimAction = (typeof SIM_ACTIONS)[number];

/** 平台页面可选的缩放比例（渲染页面“页面缩放”的选项；自动适配也只在这些值中选）。 */
export const PLATFORM_ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1] as const;

export type ShopInput = { shop_id: string; display_name: string; backend_url: string; platform_shop_id: string; adapter: "mock" | "pdd" };

export type IpcPayload =
  | { channel: "state:get" }
  | { channel: "workspace:present"; shop_id: string | null; bounds: { x: number; y: number; width: number; height: number } | null; zoom?: number }
  | { channel: "shop:save"; shop: ShopInput }
  | { channel: "shop:remove" | "shop:connect" | "shop:disconnect" | "shop:login" | "shop:logout" | "shop:reloadPage" | "shop:dismissPopups"; shop_id: string }
  | { channel: "shop:platformNav"; shop_id: string; action: "back" | "chat" }
  | { channel: "shop:setToken"; shop_id: string; token: string }
  | { channel: "shop:setMode"; shop_id: string; mode: ShopMode }
  | { channel: "app:setStartup"; launch_at_login: boolean; restart_on_crash: boolean }
  | { channel: "conv:takeover"; shop_id: string; conversation_id: string; on: boolean }
  | { channel: "sim:message"; shop_id: string; conversation_id: string; content: string; kind: "text" | "image" | "card"; stable_id: boolean }
  | { channel: "sim:action"; shop_id: string; action: SimAction; conversation_id: string | null; value: string | null };

export class IpcValidationError extends Error {}

function fail(code: string): never {
  throw new IpcValidationError(code);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("payload_not_object");
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`unexpected_field:${k}`);
  return v;
}

function id(value: unknown, name: string): string {
  if (!isIdentifier(value) || (name === "shop_id" && !isPathSafeShopId(value))) fail(`invalid_${name}`);
  return value;
}

function text(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) fail(`invalid_${name}`);
  return value;
}

export function validateShopInput(value: unknown): ShopInput {
  const v = record(value, ["shop_id", "display_name", "backend_url", "platform_shop_id", "adapter"]);
  if (v.adapter !== "mock" && v.adapter !== "pdd") fail("invalid_adapter");
  let backend_url: string;
  try {
    backend_url = normalizeBackendUrl(text(v.backend_url, "backend_url", 512));
  } catch (err) {
    fail(err instanceof ProtocolError ? err.code : "invalid_backend_url");
  }
  return {
    shop_id: id(v.shop_id, "shop_id"),
    display_name: text(v.display_name, "display_name", 64).trim(),
    backend_url,
    platform_shop_id: id(v.platform_shop_id, "platform_shop_id"),
    adapter: v.adapter,
  };
}

/** 客户端口令：可打印 ASCII、无空白，长度与后台一致（至少 32）。 */
export function validateToken(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{32,1024}$/.test(value)) fail("invalid_token");
  return value;
}

export function validateIpc(channel: unknown, payload: unknown): IpcPayload {
  if (typeof channel !== "string" || !(IPC_CHANNELS as readonly string[]).includes(channel)) fail("unknown_channel");
  const ch = channel as IpcChannel;
  switch (ch) {
    case "state:get":
      if (payload !== undefined && payload !== null) record(payload, []);
      return { channel: ch };
    case "workspace:present": {
      const v = record(payload, ["shop_id", "bounds", "zoom"]);
      if (v.zoom !== undefined && !(PLATFORM_ZOOM_LEVELS as readonly unknown[]).includes(v.zoom)) fail("invalid_workspace_zoom");
      if (v.shop_id === null && v.bounds === null) return { channel: ch, shop_id: null, bounds: null };
      const shop_id = id(v.shop_id, "shop_id");
      const b = record(v.bounds, ["x", "y", "width", "height"]);
      for (const key of ["x", "y", "width", "height"]) {
        if (typeof b[key] !== "number" || !Number.isFinite(b[key]) || (b[key] as number) < 0 || (b[key] as number) > 20000) fail("invalid_workspace_bounds");
      }
      const bounds = b as { x: number; y: number; width: number; height: number };
      return v.zoom === undefined ? { channel: ch, shop_id, bounds } : { channel: ch, shop_id, bounds, zoom: v.zoom as number };
    }
    case "shop:save": {
      const v = record(payload, ["shop"]);
      return { channel: ch, shop: validateShopInput(v.shop) };
    }
    case "shop:remove":
    case "shop:connect":
    case "shop:disconnect":
    case "shop:login":
    case "shop:logout":
    case "shop:reloadPage":
    case "shop:dismissPopups": {
      const v = record(payload, ["shop_id"]);
      return { channel: ch, shop_id: id(v.shop_id, "shop_id") };
    }
    case "shop:platformNav": {
      const v = record(payload, ["shop_id", "action"]);
      if (v.action !== "back" && v.action !== "chat") fail("invalid_nav_action");
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), action: v.action };
    }
    case "shop:setToken": {
      const v = record(payload, ["shop_id", "token"]);
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), token: validateToken(v.token) };
    }
    case "shop:setMode": {
      const v = record(payload, ["shop_id", "mode"]);
      if (!(SHOP_MODES as readonly unknown[]).includes(v.mode)) fail("invalid_mode");
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), mode: v.mode as ShopMode };
    }
    case "app:setStartup": {
      const v = record(payload, ["launch_at_login", "restart_on_crash"]);
      if (typeof v.launch_at_login !== "boolean" || typeof v.restart_on_crash !== "boolean") fail("invalid_startup_settings");
      return { channel: ch, launch_at_login: v.launch_at_login, restart_on_crash: v.restart_on_crash };
    }
    case "conv:takeover": {
      const v = record(payload, ["shop_id", "conversation_id", "on"]);
      if (typeof v.on !== "boolean") fail("invalid_on");
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), conversation_id: id(v.conversation_id, "conversation_id"), on: v.on };
    }
    case "sim:message": {
      const v = record(payload, ["shop_id", "conversation_id", "content", "kind", "stable_id"]);
      if (v.kind !== "text" && v.kind !== "image" && v.kind !== "card") fail("invalid_kind");
      if (typeof v.stable_id !== "boolean") fail("invalid_stable_id");
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), conversation_id: id(v.conversation_id, "conversation_id"), content: text(v.content, "content", 2000), kind: v.kind, stable_id: v.stable_id };
    }
    case "sim:action": {
      const v = record(payload, ["shop_id", "action", "conversation_id", "value"]);
      if (!(SIM_ACTIONS as readonly unknown[]).includes(v.action)) fail("invalid_action");
      const conversation_id = v.conversation_id === undefined || v.conversation_id === null ? null : id(v.conversation_id, "conversation_id");
      const value = v.value === undefined || v.value === null ? null : text(v.value, "value", 2000);
      if (v.action === "set_send_behavior" && !(MOCK_SEND_BEHAVIORS as readonly (string | null)[]).includes(value)) fail("invalid_send_behavior");
      if ((v.action === "toggle_history_gap" || v.action === "redeliver_last" || v.action === "agent_reply") && !conversation_id) fail("conversation_required");
      if (v.action === "agent_reply" && !value) fail("value_required");
      return { channel: ch, shop_id: id(v.shop_id, "shop_id"), action: v.action as SimAction, conversation_id, value };
    }
  }
}

export type { MockSendBehavior };
