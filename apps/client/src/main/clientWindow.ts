import { BaseWindow, WebContentsView, type BrowserWindowConstructorOptions } from "electron";

/** 本地界面也是独立视图，可覆盖后台平台页而不停止其渲染。 */
export class ClientWindow extends BaseWindow {
  readonly shellView: WebContentsView;
  readonly webContents;
  constructor({ webPreferences, ...options }: BrowserWindowConstructorOptions) {
    super(options);
    this.shellView = new WebContentsView({ webPreferences });
    this.webContents = this.shellView.webContents;
    this.contentView.addChildView(this.shellView);
    const layout = () => { const [width, height] = this.getContentSize(); this.shellView.setBounds({ x: 0, y: 0, width, height }); };
    this.on("resize", layout);
    layout();
    this.once("closed", () => { if (!this.webContents.isDestroyed()) this.webContents.close({ waitForBeforeUnload: false }); });
  }
  loadFile(file: string): Promise<void> { return this.webContents.loadFile(file); }
  capturePage() { return this.webContents.capturePage(); }
}
