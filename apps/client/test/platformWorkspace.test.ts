import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { test } from "node:test";

class FakeWc extends EventEmitter {
  destroyed = false;
  closes = 0;
  isDestroyed() { return this.destroyed; }
  async loadURL(_url: string) {}
  close(options: unknown) { assert.deepEqual(options, { waitForBeforeUnload: false }); this.closes++; this.destroyed = true; this.emit("destroyed"); }
}
class FakeView {
  webContents = new FakeWc();
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  constructor(readonly options: any = {}) {}
  setBounds(b: typeof this.bounds) { this.bounds = b; }
  getBounds() { return this.bounds; }
  setVisible(v: boolean) { this.visible = v; }
}
class FakeWindow extends EventEmitter {
  dead = false;
  size = [1200, 700];
  children: FakeView[] = [];
  contentView = {
    addChildView: (v: FakeView) => { this.children = this.children.filter(x => x !== v).concat(v); },
    removeChildView: (v: FakeView) => { this.children = this.children.filter(x => x !== v); },
  };
  isDestroyed() { return this.dead; }
  getContentSize() { return this.size; }
}
const started = new Set<number>();
let next = 0;
const fake = { WebContentsView: FakeView, powerSaveBlocker: {
  start: (kind: string) => { assert.equal(kind, "prevent-app-suspension"); started.add(++next); return next; },
  stop: (id: number) => { started.delete(id); },
} };
const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake } as unknown as NodeModule;
const { PlatformWorkspace } = req("../src/main/platformWorkspace.js") as typeof import("../src/main/platformWorkspace.js");
function setup() {
  const owner = new FakeWindow(), shell = new FakeView();
  owner.contentView.addChildView(shell);
  const ws = new PlatformWorkspace(owner as never, shell as never);
  return { owner, shell, ws };
}
const bounds = { x: 240, y: 200, width: 900, height: 480 };

test("独立会话及安全设置；未选中页由本地界面覆盖但保持挂载可见", () => {
  const { owner, shell, ws } = setup();
  const a = ws.create("shop-a"), b = ws.create("shop-b");
  assert.equal(ws.create("shop-a"), a);
  assert.notEqual(a.webContents, b.webContents);
  assert.equal(owner.children.length, 3);
  assert.equal(owner.children.at(-1), shell);
  const views = owner.children.filter(x => x !== shell);
  assert.deepEqual(views.map(v => v.options.webPreferences.partition), ["persist:claw-next-shop-shop-a", "persist:claw-next-shop-shop-b"]);
  for (const v of views) {
    assert.equal(v.visible, true);
    assert.equal(v.options.webPreferences.backgroundThrottling, false);
    assert.equal(v.options.webPreferences.nodeIntegration, false);
    assert.equal(v.options.webPreferences.sandbox, true);
    assert.equal(v.options.webPreferences.contextIsolation, true);
    assert.equal(v.options.webPreferences.preload, undefined);
  }
  assert.equal(started.size, 1);
  ws.dispose(); assert.equal(started.size, 0);
});

test("切店只调整叠放；记录页覆盖全部平台页；先选择后创建也能展示", () => {
  const { owner, shell, ws } = setup();
  ws.present("shop-a", bounds);
  const a = ws.create("shop-a"), b = ws.create("shop-b");
  assert.equal(owner.children.at(-1)?.webContents, a.webContents);
  ws.present("shop-b", bounds);
  assert.equal(owner.children.at(-1)?.webContents, b.webContents);
  ws.present(null, null);
  assert.equal(owner.children.at(-1), shell);
  assert.equal(a.isDestroyed(), false); assert.equal(b.isDestroyed(), false);
  assert.equal(owner.children.length, 3);
  ws.dispose();
});

test("夹取显示边界；无效矩形不覆盖界面；尺寸变化通知适配器丢弃旧坐标", () => {
  const { owner, shell, ws } = setup();
  const a = ws.create("shop-a"); let resized = 0;
  a.on("resized", () => resized++);
  ws.present("shop-a", { x: -10, y: -10, width: 1400, height: 900 });
  assert.deepEqual(owner.children.at(-1)?.bounds, { x: 0, y: 0, width: 1200, height: 700 });
  assert.equal(resized, 1);
  for (const b of [{...bounds, x:5000}, {...bounds,width:0}, {...bounds,x:NaN}, {...bounds,height:Infinity}]) {
    ws.present("shop-a", b); assert.equal(owner.children.at(-1), shell);
  }
  ws.present("missing", bounds); assert.equal(owner.children.at(-1), shell);
  ws.present("shop-a", bounds);
  owner.size = [800, 600]; owner.emit("resize");
  assert.deepEqual(owner.children.at(-1)?.bounds, { x: 240, y: 200, width: 560, height: 400 });
  assert.equal(resized, 3);
  ws.dispose();
});

test("关闭单店只释放自身，最后一页关闭释放保活；重复关闭通知一次", () => {
  const { owner, shell, ws } = setup();
  const a = ws.create("shop-a"), b = ws.create("shop-b"); let closed = 0;
  a.on("closed", () => closed++); a.close(); a.close();
  assert.equal(closed, 1); assert.equal(a.isDestroyed(), true); assert.equal(b.isDestroyed(), false);
  assert.equal(owner.children.length, 2); assert.equal(started.size, 1);
  b.close(); assert.equal(started.size, 0); assert.deepEqual(owner.children, [shell]);
  ws.dispose();
});

test("宿主退出显式关闭全部页面且释放监听和保活", () => {
  const { owner, ws } = setup();
  const a = ws.create("shop-a"), b = ws.create("shop-b");
  owner.dead = true; owner.emit("closed"); ws.dispose();
  assert.equal(a.isDestroyed(), true); assert.equal(b.isDestroyed(), true);
  assert.equal(started.size, 0); assert.equal(owner.listenerCount("resize"), 0);
  assert.throws(() => ws.create("shop-c"), /workspace_disposed/);
});
