import type { InboxItem, MentionJudgment } from "./protocol";

// Slack 의 mrkdwn 토큰(<@U..|이름>, <#C..|채널>, <url|글자>, <!here>)을 읽기 쉬운 글로 바꾼다. HTML 로 해석하지 않는 일반 글이다.
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@([UW][0-9A-Z]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `@${name || id}`)
    .replace(/<#([CG][0-9A-Z]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`)
    .replace(/<!subteam\^[0-9A-Z]+\|([^>]*)>/g, "$1")
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]*)>/g, (_m, url: string, label: string) => (label ? `${label} (${url})` : url))
    .replace(/<((?:https?|mailto):[^>|]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// 앱에서 바로 여는 slack:// 주소. 워크스페이스 ID(T...)가 있어야 만들 수 있고, 가져온 결과에는 ID 가 없어서 설정에서 받는다.
export function appLink(item: Pick<InboxItem, "channelId" | "ts" | "threadTs">, teamId: string): string | null {
  if (!/^T[0-9A-Z]{6,}$/.test(teamId)) return null;
  const thread = item.threadTs ? `&thread_ts=${item.threadTs}` : "";
  return `slack://channel?team=${teamId}&id=${item.channelId}&message=${item.ts}${thread}`;
}

// 스레드 안 메시지 하나의 https 퍼머링크. 결과에 메시지별 링크가 없어서 항목의 퍼머링크에서 워크스페이스 주소만 가져와 만든다.
// 부모가 아닌 메시지에는 ?thread_ts= 를 붙인다 (Slack 이 스레드 안에서 연다). 항목의 퍼머링크가 없거나 https 가 아니면 null.
// 설정 slackLinkTarget 은 링크를 누를 때 electron/main.ts 의 openExternalLink 가 적용하므로 여기서는 https 만 만든다.
export function threadMessageLink(item: Pick<InboxItem, "channelId" | "permalink" | "ts" | "threadTs">, messageTs: string): string | null {
  let origin: string;
  try {
    const url = new URL(item.permalink);
    if (url.protocol !== "https:") return null;
    origin = url.origin;
  } catch {
    return null;
  }
  if (!/^\d+\.\d+$/.test(messageTs)) return null;
  const parent = item.threadTs ?? item.ts;
  const path = `${origin}/archives/${item.channelId}/p${messageTs.replace(".", "")}`;
  return messageTs === parent ? path : `${path}?thread_ts=${parent}&cid=${item.channelId}`;
}

// --- 멘션 요청 판단과 카드 ---

// 요청으로 판단한 멘션을 분석 큐에 넣고 카드로 만드는 기준.
export const AUTO_ADD_CONFIDENCE = 0.7;

// 분석이 실패해 판단 단계의 제목과 요약으로 만든 카드에 붙는 라벨.
export const ANALYSIS_FAILED_LABEL = "analysis failed";

export type MentionAnalysisResult = {
  title: string;
  // 등록된 워크스페이스 중 관련 코드가 있는 곳. 모르면 null.
  workspaceId: string | null;
  summary: string;
  steps: string[];
  // 워크스페이스 기준 상대 경로
  relatedFiles: string[];
  links: { url: string; title: string | null }[];
  openQuestions: string[];
};

export type MentionStatus = "queued" | "analyzing" | "added" | "card-deleted" | "not-request" | "maybe" | "none";

// 목록과 상세가 보이는 상태 하나. cardExists 는 item.cardId 의 카드가 지금 보드에 있는지.
export function mentionStatus(item: Pick<InboxItem, "analysis" | "cardId" | "verdict" | "judgment">, cardExists: boolean): MentionStatus {
  const analysis = item.analysis?.status;
  if (analysis === "queued") return "queued";
  if (analysis === "running") return "analyzing";
  if (cardExists) return "added";
  if (item.cardId) return "card-deleted";
  if (item.verdict === "not-request") return "not-request";
  const judgment = item.judgment;
  if (!judgment || judgment.skipped) return "none";
  if (!judgment.isRequest) return "not-request";
  return judgment.confidence >= AUTO_ADD_CONFIDENCE ? "none" : "maybe";
}

// 카드의 제목과 본문은 한 줄씩 정리하고 길이를 제한한다 (카드 검사 한도: 제목 200, 본문 20000).
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

const fileHref = (path: string) => encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");

// 멘션으로 보드 카드를 만든다. 분석 결과가 있으면 제목, 단계, 관련 파일, 열린 질문까지 담고, 없으면 판단 단계의 제목과 요약으로 만든다.
// 본문 순서: 요약, 할 일 단계(체크리스트), 관련 파일(눌러서 에디터로 여는 링크), 열린 질문, 보낸 사람과 채널, 원문 인용, 앱 링크.
export function buildMentionCard(
  item: Pick<InboxItem, "from" | "channelName" | "channelId" | "ts" | "threadTs" | "text" | "permalink">,
  options: { judgment?: Pick<MentionJudgment, "title" | "summary"> | null; analysis?: MentionAnalysisResult | null; analysisFailed?: boolean; teamId: string },
): { title: string; body: string; labels: string[]; links: { url: string; title: string | null }[]; workspaceId: string | null } {
  const { judgment, analysis, analysisFailed, teamId } = options;
  const clean = cleanSlackText(item.text);
  const first = clean.split("\n").find((l) => l.trim()) ?? item.channelName;
  const title = oneLine(analysis?.title || judgment?.title || `${item.from.name}: ${first}`, 120) || "Slack request";
  const summary = (analysis?.summary || judgment?.summary || "").trim();
  const app = appLink(item, teamId);
  const sections: string[] = [];
  if (summary) sections.push(summary);
  if (analysis?.steps.length) sections.push(["### Steps", ...analysis.steps.map((s) => `- [ ] ${oneLine(s, 300)}`)].join("\n"));
  if (analysis?.relatedFiles.length) sections.push(["### Related files", ...analysis.relatedFiles.map((f) => `- [${f}](${fileHref(f)})`)].join("\n"));
  if (analysis?.openQuestions.length) sections.push(["### Open questions", ...analysis.openQuestions.map((q) => `- ${oneLine(q, 300)}`)].join("\n"));
  const quote = clean.length > 2000 ? `${clean.slice(0, 2000)}...` : clean;
  sections.push(["### Slack", `From ${item.from.name} in ${item.channelName}`, "", quote.split("\n").map((l) => `> ${l}`).join("\n"), ...(app ? ["", app] : [])].join("\n"));
  const links = [
    ...(item.permalink ? [{ url: item.permalink, title: "Slack message" as string | null }] : []),
    ...(analysis?.links ?? []).filter((l) => l.url !== item.permalink).slice(0, 10),
  ];
  return {
    title,
    body: sections.join("\n\n").slice(0, 19_000),
    labels: analysisFailed ? ["slack", ANALYSIS_FAILED_LABEL] : ["slack"],
    links,
    workspaceId: analysis?.workspaceId ?? null,
  };
}
