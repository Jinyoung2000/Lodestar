import { contextBridge, ipcRenderer } from "electron";

// run_playwright_code 의 숨은 샌드박스 창이 메인 프로세스와 통하는 단 하나의 길. 연산 이름과 인자만 넘기고, 메인이 그 창이 맡은 페이지 하나에만 하는 연산으로 바꾼다.
contextBridge.exposeInMainWorld("__pwHost", {
  call: (op: string, args?: unknown) => ipcRenderer.invoke("agent-nav:pw-op", op, args),
});
