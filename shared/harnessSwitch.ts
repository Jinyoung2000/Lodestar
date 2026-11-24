import { HARNESS_VALUES, harnessOf, type Agent, type Harness, type HarnessSeen, type TimelineItem } from "./protocol";

export const CARRY_MAX_CHARS = 48_000;
export const CARRY_MESSAGE_MAX_CHARS = 8_000;
export const CARRY_MAX_FILES = 100;

export const HARNESS_NAMES: Record<Harness, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

export type SwitchBlock = "running" | "background" | "waiting" | "notion" | "feedback";

type SwitchDivider = Extract<TimelineItem, { kind: "notice" }> & { switched: Harness };
type CarryAgent = Pick<Agent, "harness" | "sessionId" | "resumeFrom" | "codexThreadId" | "seenThrough" | "cwd"> & Partial<Pick<Agent, "antigravitySessionId">>;

export const otherHarness = (harness: Harness): Harness => (harness === "claude" ? "codex" : "claude");

export const otherHarnesses = (harness: Harness): Harness[] => HARNESS_VALUES.filter((value) => value !== harness);

export function isSwitchDivider(item: TimelineItem): item is SwitchDivider {
  return item.kind === "notice" && item.switched !== undefined;
}

export function lastSwitchDividerId(items: readonly TimelineItem[]): string | null {
  return items.findLast(isSwitchDivider)?.id ?? null;
}

export function harnessAtStart(items: readonly TimelineItem[], current: Harness): Harness {
  const first = items.find(isSwitchDivider);
  return first ? (first.switchedFrom ?? otherHarness(first.switched)) : current;
}

function lastIndexWhere(items: readonly TimelineItem[], match: (item: TimelineItem) => boolean, before = items.length) {
  for (let i = Math.min(before, items.length) - 1; i >= 0; i--) if (match(items[i])) return i;
  return -1;
}

export function hasOwnMemory(agent: CarryAgent): boolean {
  const harness = harnessOf(agent);
  if (harness === "codex") return !!agent.codexThreadId;
  if (harness === "antigravity") return !!agent.antigravitySessionId;
  return !!(agent.sessionId ?? agent.resumeFrom);
}

export function carryStart(items: readonly TimelineItem[], agent: CarryAgent): number {
  if (!hasOwnMemory(agent)) return 0;
  const marker = agent.seenThrough?.[harnessOf(agent)];
  const index = marker ? items.findIndex((item) => item.id === marker) : -1;
  return index === -1 ? items.length : index + 1;
}

export function switchedState(agent: Pick<Agent, "harness" | "seenThrough">, dividerId: string): Pick<Agent, "seenThrough" | "carryPending"> {
  return { seenThrough: { ...agent.seenThrough, [harnessOf(agent)]: dividerId }, carryPending: true };
}

export function carryAfterCut(kept: readonly TimelineItem[], seen: HarnessSeen | undefined): Partial<Pick<Agent, "seenThrough" | "carryPending">> {
  const toClaude = lastIndexWhere(kept, (item) => isSwitchDivider(item) && item.switched === "claude");
  if (toClaude === -1) return {};
  if (kept.slice(toClaude + 1).some((item) => item.kind === "user")) return { carryPending: false };
  const leftClaude = lastIndexWhere(kept, (item) => isSwitchDivider(item) && item.switched !== "claude", toClaude);
  const { claude: _claude, ...rest } = seen ?? {};
  return { carryPending: true, seenThrough: leftClaude === -1 ? rest : { ...rest, claude: kept[leftClaude].id } };
}

export function remapSeen(seen: HarnessSeen | undefined, mapId: (id: string) => string): HarnessSeen | undefined {
  if (!seen) return undefined;
  return Object.fromEntries(Object.entries(seen).map(([harness, id]) => [harness, mapId(id)])) as HarnessSeen;
}

export function checkpointLocked(items: readonly TimelineItem[], harness: Harness): Set<string> {
  const locked = new Set<string>();
  const until = harness !== "claude" ? items.length : lastIndexWhere(items, (item) => isSwitchDivider(item) && item.switched === "claude");
  for (let i = 0; i < until; i++) if (items[i].kind === "user") locked.add(items[i].id);
  return locked;
}

export function switchBlock(agent: Pick<Agent, "status" | "backgroundTasks" | "feedbackId">, items: readonly TimelineItem[]): SwitchBlock | null {
  if (agent.feedbackId) return "feedback";
  if (items.some((item) => item.kind === "user" && item.attachments?.some((a) => a.kind === "notion"))) return "notion";
  if (agent.status === "waiting" || items.some((item) => item.kind === "permission" && item.status === "pending")) return "waiting";
  if (agent.status === "running") return "running";
  if (agent.backgroundTasks > 0) return "background";
  return null;
}

function clip(text: string) {
  if (text.length <= CARRY_MESSAGE_MAX_CHARS) return text;
  const half = Math.floor(CARRY_MESSAGE_MAX_CHARS / 2);
  return `${text.slice(0, half)}\n[... ${text.length - half * 2} characters omitted ...]\n${text.slice(-half)}`;
}

function relativeTo(cwd: string, path: string) {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function carryTranscript(items: readonly TimelineItem[], agent: CarryAgent): string | null {
  const current = harnessOf(agent);
  const start = carryStart(items, agent);
  let tool = harnessAtStart(items, current);
  const entries: string[] = [];
  const files = new Map<string, { additions: number; deletions: number }>();
  items.forEach((item, index) => {
    if (isSwitchDivider(item)) {
      tool = item.switched;
      return;
    }
    if (index < start) return;
    if (item.kind === "user") {
      const typed = (item.shown ?? item.text).trim();
      const text = typed || (item.attachments?.length ? `[Attached: ${item.attachments.map((a) => a.label).join(", ")}]` : "");
      if (text) entries.push(`User:\n${clip(text)}`);
    } else if (item.kind === "assistant" && !item.streaming && item.text.trim()) {
      entries.push(`${HARNESS_NAMES[tool]}:\n${clip(item.text.trim())}`);
    } else if (item.kind === "result") {
      for (const file of item.changes?.list ?? []) {
        const seen = files.get(file.path) ?? { additions: 0, deletions: 0 };
        files.set(file.path, { additions: seen.additions + file.additions, deletions: seen.deletions + file.deletions });
      }
    }
  });
  if (!entries.length && !files.size) return null;
  const lastDivider = items.findLast(isSwitchDivider);
  const intro = lastDivider?.movedFrom
    ? `The text between these tags is the earlier conversation of this session. It started as a chat without a project folder (in ${lastDivider.movedFrom}), and the user moved it into this folder (${agent.cwd}), so you start fresh here and these turns are not in your memory. You are ${HARNESS_NAMES[current]}.`
    : `The text between these tags is the earlier conversation of the same task in this folder (${agent.cwd}). You are ${HARNESS_NAMES[current]}. The user switched this session to you, and these turns are not in your memory.`;
  const head = [
    "<earlier-conversation>",
    `${intro} Replies labelled with a tool name (${HARNESS_VALUES.map((value) => HARNESS_NAMES[value]).join(", ")}) came from that tool. Treat this as background, not as a new request. The user's new message follows after the closing tag.`,
  ].join("\n");
  const fileList = [...files].slice(0, CARRY_MAX_FILES).map(([path, n]) => `- ${relativeTo(agent.cwd, path)} (+${n.additions} -${n.deletions})`);
  const fileBlock = fileList.length ? `Files changed in these turns:\n${fileList.join("\n")}${files.size > CARRY_MAX_FILES ? `\n- ... ${files.size - CARRY_MAX_FILES} more` : ""}` : "";
  const tail = "</earlier-conversation>";
  const budget = CARRY_MAX_CHARS - head.length - fileBlock.length - tail.length - 200;
  let used = 0;
  let keep = entries.length;
  while (keep > 0 && used + entries[keep - 1].length + 2 <= budget) {
    used += entries[keep - 1].length + 2;
    keep -= 1;
  }
  const dropped = keep;
  const body = [...(dropped ? [`[${dropped} earlier ${dropped === 1 ? "message" : "messages"} omitted to keep this short]`] : []), ...entries.slice(dropped), ...(fileBlock ? [fileBlock] : [])];
  return [head, "", body.join("\n\n"), tail].join("\n");
}
