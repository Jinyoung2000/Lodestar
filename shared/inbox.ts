import type { InboxItem, MentionJudgment } from "./protocol";

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

export function appLink(item: Pick<InboxItem, "channelId" | "ts" | "threadTs">, teamId: string): string | null {
  if (!/^T[0-9A-Z]{6,}$/.test(teamId)) return null;
  const thread = item.threadTs ? `&thread_ts=${item.threadTs}` : "";
  return `slack://channel?team=${teamId}&id=${item.channelId}&message=${item.ts}${thread}`;
}

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

export const AUTO_ADD_CONFIDENCE = 0.7;

export const ANALYSIS_FAILED_LABEL = "analysis failed";

export type MentionAnalysisResult = {
  title: string;
  workspaceId: string | null;
  summary: string;
  steps: string[];
  relatedFiles: string[];
  links: { url: string; title: string | null }[];
  openQuestions: string[];
};

export type MentionStatus = "queued" | "analyzing" | "added" | "card-deleted" | "not-request" | "maybe" | "none";

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

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

const fileHref = (path: string) => encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");

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
