// Slack 초안 미리보기. 응답 속 ```slack 코드 블록을 Slack 에서 보일 모양(굵게, 기울임, 취소선, <주소|글> 링크, 멘션, 목록, 인용)으로 그린 카드로 바꾼다.
// 복사 버튼은 HTML 과 원문(mrkdwn)을 함께 클립보드에 넣는다. Slack 입력창은 HTML 을 읽어 같은 서식으로 붙여 넣는다.
// 세션은 server/agents.ts 의 SESSION_PROMPT_APPEND 로 Slack 메시지를 이 블록에 쓰도록 안내받는다.

const SLACK_LANGUAGE = /(?:^|\s)language-slack(?:\s|$)/;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 이미 이스케이프된 글에 *굵게*, _기울임_, ~취소선~ 을 입힌다. 기호 바로 안쪽이 공백이면 서식으로 보지 않는다(Slack 과 같다).
function emphasis(s: string): string {
  return s
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, "$1<s>$2</s>");
}

function link(href: string, label: string): string {
  return /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${emphasis(escapeHtml(label))}</a>` : escapeHtml(label);
}

// <...> 한 개: <주소|글>, <주소>, <@U123|이름>, <#C123|채널>, <!here>
function angle(body: string): string {
  const bar = body.indexOf("|");
  const target = bar < 0 ? body : body.slice(0, bar);
  const label = bar < 0 ? null : body.slice(bar + 1);
  if (/^@[UW][A-Z0-9]+$/.test(target)) return `<span class="slack-mention">@${escapeHtml(label ?? target.slice(1))}</span>`;
  if (/^#C[A-Z0-9]+$/.test(target)) return `<span class="slack-mention">#${escapeHtml(label ?? target.slice(1))}</span>`;
  if (/^!(here|channel|everyone)$/.test(target)) return `<span class="slack-mention">@${escapeHtml(target.slice(1))}</span>`;
  if (/^(https?:|mailto:)/i.test(target)) return link(target, label ?? target);
  return escapeHtml(`<${body}>`);
}

const INLINE_TOKEN = /`([^`\n]+)`|<([^<>\n]+)>|(https?:\/\/[^\s<>]+)/g;

function inline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)));
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) out += angle(m[2]);
    else out += link(m[3]!, m[3]!);
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHtml(text.slice(last)));
}

const BULLET = /^\s*[•◦▪\-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const QUOTE = /^>\s?/;

// mrkdwn 글 전체를 HTML 로. 빈 줄은 문단을 나누고, 같은 문단 안의 줄바꿈은 <br> 로 둔다.
export function renderSlackMrkdwn(source: string): string {
  const lines = source.replace(/\s+$/, "").split("\n");
  const blocks: string[] = [];
  let i = 0;
  const take = (test: RegExp) => {
    const group: string[] = [];
    while (i < lines.length && test.test(lines[i]!)) group.push(lines[i++]!.replace(test, ""));
    return group;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (QUOTE.test(line)) {
      blocks.push(`<blockquote>${take(QUOTE).map(inline).join("<br>")}</blockquote>`);
    } else if (BULLET.test(line)) {
      blocks.push(`<ul>${take(BULLET).map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    } else if (NUMBERED.test(line)) {
      blocks.push(`<ol>${take(NUMBERED).map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
    } else {
      const group: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !QUOTE.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!)) group.push(lines[i++]!);
      blocks.push(`<p>${group.map(inline).join("<br>")}</p>`);
    }
  }
  return blocks.join("");
}

// 정리된(DOMPurify) 응답 HTML 에서 ```slack 블록을 미리보기 카드로 바꾼다. 카드 안 HTML 은 renderSlackMrkdwn 이 글을 모두 이스케이프해 만든다.
export function slackPreviews(html: string, label: string): string {
  if (!html.includes("language-slack")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const code of doc.querySelectorAll("pre > code")) {
    if (!SLACK_LANGUAGE.test(code.className)) continue;
    const source = code.textContent ?? "";
    const card = doc.createElement("div");
    card.className = "slack-preview";
    card.dataset.slackSource = source;
    const head = doc.createElement("div");
    head.className = "slack-preview-head";
    const name = doc.createElement("span");
    name.textContent = label;
    head.append(name);
    const body = doc.createElement("div");
    body.className = "slack-preview-body";
    body.innerHTML = renderSlackMrkdwn(source);
    card.append(head, body);
    code.parentElement!.replaceWith(card);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

// 카드 머리 오른쪽에 복사 버튼을 붙인다. 같은 카드에 두 번 붙이지 않는다.
export function addSlackCopyButtons(root: HTMLElement, label: string, copiedLabel: string) {
  for (const card of root.querySelectorAll<HTMLElement>(".slack-preview")) {
    const head = card.querySelector(":scope > .slack-preview-head");
    const body = card.querySelector(":scope > .slack-preview-body");
    if (!head || !body || head.querySelector(".slack-copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button slack-copy";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    const show = (copied: boolean) => {
      icon.className = copied ? "codicon codicon-check" : "codicon codicon-copy";
      button.title = copied ? copiedLabel : label;
      button.setAttribute("aria-label", copied ? copiedLabel : label);
    };
    show(false);
    button.append(icon);
    let timer: number | undefined;
    button.addEventListener("click", () => {
      const plain = card.dataset.slackSource ?? body.textContent ?? "";
      const done = () => {
        show(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => show(false), 1500);
      };
      const rich = typeof ClipboardItem === "function"
        ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([body.innerHTML], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })])
        : Promise.reject(new Error("no ClipboardItem"));
      void rich.catch(() => navigator.clipboard.writeText(plain)).then(done);
    });
    head.append(button);
  }
}
