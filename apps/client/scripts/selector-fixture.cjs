// 仅供开发检查：独立数据目录、虚构 data: 页面，禁止网络请求。
const { app, BrowserWindow } = require("electron");
if (!process.env.CLAW_NEXT_SELECTOR_DATA) throw new Error("missing isolated test directory");
app.setPath("userData", process.env.CLAW_NEXT_SELECTOR_DATA);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith("data:") }));
  await win.loadURL("data:text/html;charset=utf-8,<title>fictional selector fixture</title>");
  win.showInactive();
});
