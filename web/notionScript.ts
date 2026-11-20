// Notion 페이지 안에서 도는 스크립트(<webview> 의 executeJavaScript 로 넣는다). 페이지를 바꾸지 않고 읽기만 하며, 결과는 JSON 글이다.
// 클래스 이름(.notion-page-content, notion-<종류>-block, data-block-id, data-content-editable-leaf)은 Notion 웹 화면에서 관찰한 것이라, 실제 Notion 이 바뀌면 이 파일만 고친다.

// 본문이 그려졌는지: ready(본문 블록 있음), login(로그인 화면), loading(아직)
export const NOTION_PROBE_SCRIPT = `(() => {
  const root = document.querySelector(".notion-page-content");
  if (root && (root.querySelector("[data-block-id]") || (root.textContent || "").trim())) return "ready";
  const login = /^\\/(login|signup|sign-up)(\\/|$)/.test(location.pathname) || !!document.querySelector("input[type=email], input[name=email], .notion-login");
  return login && !root ? "login" : "loading";
})()`;

// 본문을 블록 트리로. shared/notionMarkdown.ts 의 NotionBlock 모양으로 JSON.stringify 한 글을 돌려준다.
export const NOTION_READ_SCRIPT = `(() => {
  const root = document.querySelector(".notion-page-content");
  if (!root) return JSON.stringify({ ok: false, reason: "empty" });
  const BLOCK = "[data-block-id]";
  const LEAF = "[data-content-editable-leaf]";
  const MAX_BLOCKS = 4000;
  const MAX_DB_ROWS = 50;
  let count = 0;
  const rootOwner = root.closest(BLOCK);
  const ownerOf = (el) => (el.parentElement ? el.parentElement.closest(BLOCK) : null);
  const kindOf = (el) => {
    const m = /(?:^|\\s)notion-([a-z_]+)-block(?:\\s|$)/.exec(el.className && el.className.baseVal === undefined ? el.className : "");
    return m ? m[1] : "";
  };
  const childrenOf = (container) => {
    const owner = container === root ? rootOwner : container;
    return Array.from(container.querySelectorAll(BLOCK)).filter((el) => ownerOf(el) === owner);
  };
  const ownLeaves = (block) => Array.from(block.querySelectorAll(LEAF)).filter((leaf) => ownerOf(leaf) === block);
  const css = (el, name) => ((el.getAttribute("style") || "").match(new RegExp(name + "\\\\s*:\\\\s*([^;]+)", "i")) || [])[1] || "";
  const inline = (node) => {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "\\n";
    if (tag === "script" || tag === "style") return "";
    let text = Array.from(node.childNodes).map(inline).join("");
    if (!text.trim()) return text;
    const family = css(node, "font-family");
    if (tag === "code" || /mono|consolas/i.test(family)) text = "\`" + text.trim() + "\`";
    if (tag === "b" || tag === "strong" || /^(6|7|8|9)00$|bold/.test(css(node, "font-weight").trim())) text = "**" + text.trim() + "**";
    if (tag === "i" || tag === "em" || /italic/.test(css(node, "font-style"))) text = "*" + text.trim() + "*";
    if (tag === "s" || tag === "del" || /line-through/.test(css(node, "text-decoration"))) text = "~~" + text.trim() + "~~";
    if (tag === "a" && node.getAttribute("href")) {
      const href = new URL(node.getAttribute("href"), location.href).href;
      text = "[" + text.trim() + "](" + href + ")";
    }
    return text;
  };
  const textOf = (block) => ownLeaves(block).map(inline).join("\\n").replace(/\\u200b/g, "").trim();
  const plain = (el) => (el.textContent || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
  const cellsOf = (row) => {
    const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"], .notion-table-cell, td'));
    return cells.length ? cells.map(plain) : ownLeaves(row).map((leaf) => plain(leaf));
  };
  const walk = (el) => {
    if (++count > MAX_BLOCKS) return null;
    const kind = kindOf(el);
    const kids = () => childrenOf(el).map(walk).filter(Boolean);
    const level = { header: 1, sub_header: 2, sub_sub_header: 3, sub_sub_sub_header: 3 }[kind];
    if (level) return { type: "heading", level, text: textOf(el), children: kids() };
    switch (kind) {
      case "bulleted_list": return { type: "bullet", text: textOf(el), children: kids() };
      case "numbered_list": return { type: "number", text: textOf(el), children: kids() };
      case "to_do": {
        const box = el.querySelector('input[type="checkbox"], [role="checkbox"]');
        const checked = !!box && (box.checked === true || box.getAttribute("aria-checked") === "true" || box.getAttribute("data-checked") === "true");
        return { type: "todo", text: textOf(el), checked: checked || !!el.querySelector(".notion-todo-checked, [data-todo-checked]"), children: kids() };
      }
      case "toggle": return { type: "toggle", text: textOf(el), children: kids() };
      case "quote": return { type: "quote", text: textOf(el), children: kids() };
      case "callout": return { type: "callout", text: textOf(el), children: kids() };
      case "code": {
        const leaf = ownLeaves(el)[0];
        const lang = (el.querySelector("[role=button]") || {}).textContent || "";
        return { type: "code", lang: /^[A-Za-z0-9+#.-]{1,20}$/.test(lang.trim()) ? lang.trim().toLowerCase() : "", text: leaf ? (leaf.textContent || "").replace(/\\u200b/g, "") : "" };
      }
      case "divider": return { type: "divider" };
      case "table": return { type: "table", rows: childrenOf(el).filter((row) => kindOf(row) === "table_row").map(cellsOf) };
      case "image": return { type: "image", text: textOf(el) || ((el.querySelector("img") || {}).alt || "") };
      case "bookmark":
      case "embed":
      case "video":
      case "file":
      case "pdf":
      case "audio": {
        const link = el.querySelector("a[href]");
        return { type: kind === "bookmark" ? "link" : "embed", text: textOf(el) || plain(el), href: link ? new URL(link.getAttribute("href"), location.href).href : "" };
      }
      case "page": {
        const link = el.querySelector("a[href]");
        return { type: "page", text: textOf(el) || plain(el), href: link ? new URL(link.getAttribute("href"), location.href).href : "" };
      }
      case "collection_view":
      case "collection_view_page": {
        const rows = Array.from(el.querySelectorAll(".notion-collection-item, .notion-table-view-row, .notion-list-view-item")).slice(0, MAX_DB_ROWS);
        const items = rows.map((row) => ({ type: "bullet", text: plain(row) })).filter((item) => item.text);
        return { type: "database", text: textOf(el), children: items };
      }
      case "column_list":
      case "column":
      case "transclusion_container":
      case "transclusion_reference":
      case "synced_block": return { type: "group", children: kids() };
      default: return { type: "text", text: textOf(el), children: kids() };
    }
  };
  const flatten = (blocks) => blocks.flatMap((b) => (b.type === "group" ? flatten(b.children || []) : [{ ...b, children: b.children ? flatten(b.children) : undefined }]));
  const blocks = flatten(childrenOf(root).map(walk).filter(Boolean));
  const heading = document.querySelector(".notion-page-block h1, h1");
  return JSON.stringify({ ok: true, title: (document.title || (heading && heading.textContent) || "").trim(), url: location.href, blocks, cut: count > MAX_BLOCKS });
})()`;
