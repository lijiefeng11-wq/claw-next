// 沙箱预加载脚本：不能引用本地模块，所以通道清单在此重复列出，并由主进程再次校验。
{
  const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
  const allowed = new Set([
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
  ]);
  contextBridge.exposeInMainWorld("clawNext", {
    invoke(channel: string, payload?: unknown): Promise<unknown> {
      if (!allowed.has(channel)) return Promise.reject(new Error("channel_not_allowed"));
      return ipcRenderer.invoke(channel, payload);
    },
    onState(callback: (state: unknown) => void): () => void {
      const handler = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("state:changed", handler);
      return () => ipcRenderer.removeListener("state:changed", handler);
    },
  });
}
