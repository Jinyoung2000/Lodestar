import { isNotionUrl, notionPageKey, notionTitleFromUrl } from "../shared/notionLink";
import { notionPageText } from "../shared/notionMarkdown";
import type { BrowserAttachment } from "./browserAttach";
import { ATTACH_LIMIT, clip } from "../shared/notionContext";
import { hint } from "./hint";
import { rpc } from "./rpc";
import { N } from "./notionStrings";
import { readFromTab, readInBackground, type NotionRead } from "./notionPage";
import { activePane, addAttachment, findAttachedDuplicate, flash, getState, type BrowserTab } from "./store";

// Browser 탭의 Page 첨부(Add Page to Chat 계열)와 같은 길을 쓴다: 읽은 내용을 입력창 칩(browser 첨부) 하나로 붙인다. Notion 이면 스크린샷 대신 본문을 마크다운으로 붙인다.
// 같은 페이지는 칩이 하나다(web/attachDedupe.ts 의 chipIdentity). 이미 붙어 있으면 읽지 않고 기존 칩만 강조한다.

const reading = new Set<string>();

// 이미 열려 있는 탭이 있으면 그 탭에서, 없으면 눈에 안 보이는 webview 로 읽어 첨부한다. paneId 를 안 주면 활성 칸.
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
    // NOTION2: 화면을 긁지 않고 Notion MCP 로 읽은 원문을 붙인다. MCP 로 못 읽을 때만(연결 안 됨 등) 열린 탭이나 눈에 안 보이는 webview 를 읽는 옛 길로 물러난다.
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
    // 탭에서 못 읽으면(막 닫혔거나 아직 안 뜸) 눈에 안 보이는 webview 로 한 번 더 읽는다
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
