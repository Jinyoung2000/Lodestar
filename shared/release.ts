export const LODESTAR_REPOSITORY = "Jinyoung2000/Lodestar";
export const LODESTAR_REPOSITORY_URL = `https://github.com/${LODESTAR_REPOSITORY}`;
export const NEW_ISSUE_URL = `${LODESTAR_REPOSITORY_URL}/issues/new`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${LODESTAR_REPOSITORY}/releases/latest`;

export const ISSUE_URL_LIMIT = 7000;
const TITLE_LIMIT = 200;
export const ISSUE_BODY_CUT_NOTE = "(Shortened to fit the link.)";

export type ReleaseState = {
  installed: string;
  macos: string | null;
  latest: { version: string; url: string } | null;
  dismissed: string | null;
};

export function parseVersion(text: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(text.trim());
  if (!match) return null;
  const parts = match[1].split(".").map(Number);
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : null;
}

export function isNewerVersion(tag: string, current: string): boolean {
  const next = parseVersion(tag);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < Math.max(next.length, now.length); i++) {
    const a = next[i] ?? 0;
    const b = now[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export function releaseFromApi(value: unknown): { version: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof raw.tag_name !== "string" || raw.draft === true || raw.prerelease === true) return null;
  const tag = raw.tag_name.trim();
  if (!parseVersion(tag)) return null;
  return { version: tag.replace(/^v/, ""), url: `${LODESTAR_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}` };
}

export function newIssueUrl(title: string, text: string, footer = "", limit = ISSUE_URL_LIMIT): string {
  const head = `${NEW_ISSUE_URL}?title=${encodeURIComponent([...title.trim()].slice(0, TITLE_LIMIT).join(""))}&body=`;
  const full = encodeURIComponent(text + footer);
  if (head.length + full.length <= limit) return head + full;
  const chars = [...text];
  const bodyOf = (n: number) => `${chars.slice(0, n).join("").trimEnd()}\n\n${ISSUE_BODY_CUT_NOTE}${footer}`;
  const fits = (n: number) => head.length + encodeURIComponent(bodyOf(n)).length <= limit;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return head + encodeURIComponent(bodyOf(low));
}

export function releaseToNotify(state: ReleaseState | null): { version: string; url: string } | null {
  const latest = state?.latest;
  if (!state || !latest || !isNewerVersion(latest.version, state.installed) || state.dismissed === latest.version) return null;
  return latest;
}

export function issueTitleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
