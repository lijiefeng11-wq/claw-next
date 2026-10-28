import { WebContentsView, powerSaveBlocker, type BaseWindow, type View, type WebContents } from "electron";
import { PLATFORM_WEB_PREFERENCES, partitionFor } from "../core/security.js";

export type PlatformPage = {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  close(): void;
  on(event: "closed" | "resized", listener: () => void): unknown;
};
export type WorkspaceBounds = { x: number; y: number; width: number; height: number };
type Slot = { view: WebContentsView; wc: WebContents; page: PlatformPage; closed: boolean; listeners: Set<() => void>; resized: Set<() => void> };

/** 每店独立页面，切店只切可见性；后台页面仍挂载且不因失焦而节流。 */
export class PlatformWorkspace {
  private readonly slots = new Map<string, Slot>();
  private selected: string | null = null;
  private requested: WorkspaceBounds | null = null;
  private blocker: number | null = null;
  private disposed = false;
  private readonly resize = () => this.present(this.selected, this.requested);
  private readonly closed = () => this.dispose();

  constructor(private readonly owner: BaseWindow, private readonly shell: View) {
    owner.on("resize", this.resize);
    owner.on("closed", this.closed);
  }

  create(shopId: string): PlatformPage {
    if (this.disposed || this.owner.isDestroyed()) throw new Error("workspace_disposed");
    const existing = this.slots.get(shopId);
    if (existing) return existing.page;
    const view = new WebContentsView({ webPreferences: { ...PLATFORM_WEB_PREFERENCES, partition: partitionFor(shopId), backgroundThrottling: false } });
    // 独立保存引用：视图销毁后 view.webContents 可能已不可用。
    const wc = view.webContents;
    view.setBounds({ x: 0, y: 0, width: 1100, height: 650 });
    view.setVisible(true);
    this.owner.contentView.addChildView(view);
    const slot: Slot = { view, wc, page: undefined as unknown as PlatformPage, closed: false, listeners: new Set(), resized: new Set() };
    slot.page = {
      webContents: wc,
      isDestroyed: () => slot.closed || wc.isDestroyed(),
      loadURL: (url) => wc.loadURL(url),
      close: () => this.close(shopId, slot),
      on: (event, listener) => { if (slot.closed) { if (event === "closed") listener(); } else (event === "closed" ? slot.listeners : slot.resized).add(listener); },
    };
    this.slots.set(shopId, slot);
    wc.once("destroyed", () => this.release(shopId, slot));
    if (this.blocker === null) this.blocker = powerSaveBlocker.start("prevent-app-suspension");
    this.resize();
    return slot.page;
  }

  present(shopId: string | null, bounds: WorkspaceBounds | null): void {
    if (this.disposed || this.owner.isDestroyed()) return;
    this.selected = shopId;
    this.requested = bounds ? { ...bounds } : null;
    const [width, height] = this.owner.getContentSize();
    let rect: WorkspaceBounds | null = null;
    if (bounds && Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0) {
      const x = Math.max(0, Math.round(bounds.x)), y = Math.max(0, Math.round(bounds.y));
      const right = Math.min(width, Math.round(bounds.x + bounds.width)), bottom = Math.min(height, Math.round(bounds.y + bounds.height));
      if (right > x && bottom > y) rect = { x, y, width: right - x, height: bottom - y };
    }
    // 所有平台页保持可见、挂载在本地界面后方；setVisible(false) 会使 macOS 丢弃 CDP 点击。
    this.owner.contentView.addChildView(this.shell);
    const selected = shopId === null ? undefined : this.slots.get(shopId);
    if (selected && rect && !selected.closed && !selected.wc.isDestroyed()) {
      const before = selected.view.getBounds();
      selected.view.setBounds(rect);
      if (before.width !== rect.width || before.height !== rect.height) for (const listener of selected.resized) listener();
      this.owner.contentView.addChildView(selected.view);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.removeListener("resize", this.resize);
    this.owner.removeListener("closed", this.closed);
    for (const [id, slot] of [...this.slots]) this.close(id, slot);
  }

  private close(id: string, slot: Slot): void {
    if (slot.closed) return;
    try { this.release(id, slot); } finally {
      if (!slot.wc.isDestroyed()) slot.wc.close({ waitForBeforeUnload: false });
    }
  }

  private release(id: string, slot: Slot): void {
    if (slot.closed) return;
    slot.closed = true;
    if (this.slots.get(id) === slot) this.slots.delete(id);
    if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(slot.view);
    if (!this.slots.size && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
    const listeners = [...slot.listeners];
    slot.listeners.clear();
    slot.resized.clear();
    for (const listener of listeners) listener();
  }
}
