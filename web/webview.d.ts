// Electron 의 <webview> 태그. React 의 JSX 에는 없어서 필요한 속성과 메서드만 선언한다.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string; webpreferences?: string };
    }
  }
}

export type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
  getURL(): string;
  openDevTools(): void;
  getWebContentsId(): number;
  setZoomLevel(level: number): void;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  executeJavaScript(code: string): Promise<unknown>;
};
