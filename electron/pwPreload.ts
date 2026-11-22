import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__pwHost", {
  call: (op: string, args?: unknown) => ipcRenderer.invoke("agent-nav:pw-op", op, args),
});
