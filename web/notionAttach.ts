import { isNotionUrl, notionPageKey, notionTitleFromUrl } from "../shared/notionLink";
import { notionPageText } from "../shared/notionMarkdown";
import type { BrowserAttachment } from "./browserAttach";
import { ATTACH_LIMIT, clip } from "../shared/notionContext";
import { hint } from "./hint";
import { rpc } from "./rpc";
import { N } from "./notionStrings";
import { readFromTab, readInBackground, type NotionRead } from "./notionPage";
import { activePane, addAttachment, findAttachedDuplicate, flash, getState, type BrowserTab } from "./store";

const reading = new Set<string>();

export async function attachNotionPage(page: { url: string; title?: string; tabKey?: string; paneId?: string }): Promise<boolean> {
  if (!isNotionUrl(page.url)) return false;
  const paneId = page.paneId ?? activePane().id;
  const pageKey = notionPageKey(page.url);
  const placeholder = { workspaceId: null, path: page.url, startLine: null, endLine: null, text: null, browser: { kind: "notion", url: page.url, title: page.title ?? "", pageKey, markdown: "", truncated: false, chars: 0 } satisfies BrowserAttachment };
  if (findAttachedDuplicate(paneId, placeholder)) {
    addAttachment(paneId, placeholder);
    return true;
  }
  const guardKey = `${paneId}:${pageKey}`;
  if (reading.has(guardKey)) return true;
  reading.add(guardKey);
  hint(N.reading);
  try {
    const viaMcp = await rpc.call("notion.page.read", { url: page.url }).then((view) => ({ ok: true as const, view }), (error: Error) => ({ ok: false as const, message: error.message }));
    if (viaMcp.ok) {
      const { page: data } = viaMcp.view;
      const clipped = clip(data.markdown, ATTACH_LIMIT);
      addAttachment(paneId, { ...placeholder, browser: { kind: "notion", url: page.url, title: page.title?.trim() || data.title, pageKey, markdown: clipped.text, truncated: clipped.truncated, chars: clipped.total } });
      hint(N.added, undefined, { check: true });
      return true;
    }
    if (!window.agentNavNative) {
      flash(`${N.attachFailed} (${viaMcp.message})`);
      return false;
    }
    const open = page.tabKey ? { key: page.tabKey } : getState().tabs.find((t): t is BrowserTab => t.kind === "browser" && isNotionUrl(t.url) && notionPageKey(t.url) === pageKey);
    const read: NotionRead = open ? await readFromTab(open.key) : await readInBackground(page.url);
    const result = !read.ok && read.reason === "unavailable" ? await readInBackground(page.url) : read;
    if (!result.ok) {
      flash(result.reason === "login" ? N.needLogin : N.cantRead);
      return false;
    }
    const text = notionPageText(result.blocks);
    const title = page.title?.trim() || result.title || notionTitleFromUrl(page.url) || "Untitled";
    addAttachment(paneId, { ...placeholder, browser: { kind: "notion", url: page.url, title, pageKey, markdown: text.markdown, truncated: text.truncated, chars: text.chars } });
    hint(N.added, undefined, { check: true });
    return true;
  } finally {
    reading.delete(guardKey);
  }
}
