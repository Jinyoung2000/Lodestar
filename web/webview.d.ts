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
