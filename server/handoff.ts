import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Agent } from "../shared/protocol";
import { claudeBin, claudeEnv, isAuthError } from "./claude";
import * as gitOps from "./git";
import { HOME } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

// HANDOFF: 지금 세션의 기록으로 새 세션에 건넬 인계 문서를 만든다.
// 원 세션을 resume 하되 forkSession 으로 갈라서 읽기만 하고(persistSession: false 라 새 기록 파일도 만들지 않는다), 도구 없이 한 번 답하게 한다. 원 세션의 기록 파일은 바뀌지 않는다(.verify 시험으로 크기와 수정 시각을 비교).
export const HANDOFF_DIR = join(HOME, "handoffs");
const TIMEOUT_MS = 180_000;
const ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{6}$/;

// 문서는 사용자가 이 대화에서 쓴 언어로 쓰게 한다. 섹션 이름도 그 언어로 옮긴다.
export const HANDOFF_SYSTEM_PROMPT = [
  "You write handoff documents for coding sessions. You can see the whole conversation so far, and you answer without using any tool.",
  "Write only what the conversation supports. If something was not verified, say it was not verified. Never invent file paths, commands or results.",
].join("\n");

export const HANDOFF_PROMPT = [
  "Write a handoff document so a brand new session can continue this work without seeing this conversation.",
  "Write it in the language the user mainly used in this conversation (for example Korean when the user wrote in Korean), including the section titles. Keep code identifiers, file paths and commands as they are.",
  "Output only the document as Markdown, no title line, no preamble and no closing remarks, with exactly these sections in this order (use second-level headings):",
  "1. Goal: what the user wants in the end, in two or three sentences.",
  "2. Decisions: each decision that was settled, with the reason for it.",
  "3. Changed files: each file changed so far, what changed, and its state (done, partly done, or not verified).",
  "4. Remaining work: the next steps in order.",
  "5. Cautions: traps found, approaches that were tried and rejected, and things the user asked not to do.",
  "6. Related paths: files, commands, URLs and ids worth opening first.",
  "Keep every section short. Leave a section's body as a single dash when there is nothing to say.",
].join("\n");

// 문서를 만드는 질문은 도구 없이 대화만 보므로, Source Control 패널이나 터미널에서 만든 커밋은 대화에 없다(dogfood 2회차 10번).
// 그래서 지금 작업 폴더의 git 상태를 읽어 질문 끝에 붙이고, 대화와 다르면 이쪽이 맞다고 알려 준다.
const GIT_LOG_COUNT = 5;
const GIT_STATUS_LINES = 30;

// sessionFiles 는 이 세션의 에이전트가 만진 파일(서버의 장부, 상대 경로). 아래 폴더 전체의 git 상태에는 다른 세션과 사용자의 변경이 섞여 있어서, 이 세션 것을 따로 알려 준다.
export async function gitStateBlock(cwd: string, sessionFiles: string[] | null = null): Promise<string | null> {
  const run = (args: string[]) => gitOps.git(cwd, args).then((out) => out.trim(), () => null);
  if ((await run(["rev-parse", "--git-dir"])) === null) return null;
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])) ?? "unknown";
  const log = await run(["log", `-${GIT_LOG_COUNT}`, "--format=%h %cr: %s"]);
  const status = await run(["status", "--short"]);
  const changed = status ? status.split("\n") : [];
  const shown = changed.slice(0, GIT_STATUS_LINES);
  return [
    `Git state of the working folder, read just now (branch ${branch}). Commits and edits made outside this conversation, for example from a Source Control panel or a terminal, appear only here. If this disagrees with the conversation about what is committed, this is correct. Say in the Changed files section which work is committed and which is not.`,
    `Last ${GIT_LOG_COUNT} commits:`,
    log || "(no commits yet)",
    changed.length === 0 ? "Uncommitted changes: none" : `Uncommitted changes (${changed.length} files, git status --short, the whole folder, so it can include other sessions' or the user's edits):\n${shown.join("\n")}${changed.length > shown.length ? `\n... and ${changed.length - shown.length} more` : ""}`,
    ...(sessionFiles ? [sessionFiles.length === 0 ? "Files this session edited: none" : `Files this session edited (from its edit record, ${sessionFiles.length} files):\n${sessionFiles.slice(0, GIT_STATUS_LINES).join("\n")}${sessionFiles.length > GIT_STATUS_LINES ? `\n... and ${sessionFiles.length - GIT_STATUS_LINES} more` : ""}\nOnly these files are this session's work. Describe the other uncommitted files as not from this session.`] : []),
  ].join("\n");
}

export const validHandoffId = (id: unknown): id is string => typeof id === "string" && ID_PATTERN.test(id);
export const handoffPath = (id: string) => join(HANDOFF_DIR, `${id}.md`);
const newHandoffId = () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

const generating = new Set<string>();

export async function generateHandoff(agent: Agent, sessionFiles: string[] | null = null): Promise<{ id: string; title: string; text: string; path: string }> {
  if (!agent.sessionId) throw new Error(T.errHandoffNoSession);
  if (generating.has(agent.id)) throw new Error(T.errHandoffRunning);
  generating.add(agent.id);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    let result = "";
    let failure: string | null = null;
    const gitState = agent.workspaceId === null ? null : await gitStateBlock(agent.cwd, sessionFiles);
    const q = query({
      prompt: gitState ? `${HANDOFF_PROMPT}\n\n${gitState}` : HANDOFF_PROMPT,
      options: {
        cwd: agent.cwd,
        env: claudeEnv(),
        // 이 세션이 지금 쓰는 모델(마지막 턴에서 실제로 쓰인 것)로 쓴다
        model: agent.activeModel ?? agent.model ?? undefined,
        resume: agent.sessionId,
        resumeSessionAt: agent.resumeAt ?? undefined,
        forkSession: true,
        persistSession: false,
        tools: [],
        settingSources: [],
        maxTurns: 2,
        systemPrompt: HANDOFF_SYSTEM_PROMPT,
        pathToClaudeCodeExecutable: claudeBin(),
        spawnClaudeCodeProcess: spawnInGroup,
        abortController: abort,
      },
    });
    try {
      for await (const message of q) {
        if (message.type !== "result") continue;
        if (message.subtype === "success" && !message.is_error) result = message.result;
        else failure = message.subtype === "success" ? message.result : message.subtype;
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Error(T.errHandoffTimeout);
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(isAuthError(text) ? T.reloginHint(text) : text);
    } finally {
      q.close();
    }
    if (abort.signal.aborted) throw new Error(T.errHandoffTimeout);
    if (failure) throw new Error(failure);
    const body = result.trim();
    if (!body) throw new Error(T.errHandoffEmpty);
    const text = `# ${T.handoffTitle(agent.title)}\n\n${body}\n`;
    const id = newHandoffId();
    mkdirSync(HANDOFF_DIR, { recursive: true });
    writeFileSync(handoffPath(id), text);
    return { id, title: agent.title, text, path: handoffPath(id) };
  } finally {
    clearTimeout(timer);
    generating.delete(agent.id);
  }
}

export function readHandoff(id: string): { id: string; text: string; path: string } {
  if (!validHandoffId(id)) throw new Error(T.errHandoffUnknown);
  try {
    return { id, text: readFileSync(handoffPath(id), "utf8"), path: handoffPath(id) };
  } catch {
    throw new Error(T.errHandoffUnknown);
  }
}

// 칩에서 고친 문서. 이미 만들어진 문서만 덮어쓴다(새 id 를 만들지 않는다).
export function saveHandoff(id: string, text: string) {
  readHandoff(id);
  if (typeof text !== "string") throw new Error(T.errHandoffEmpty);
  // 사용자가 고친 글을 덮어쓰는 자리라 임시 파일에 쓴 뒤 바꾼다(도중에 끊겨도 반쪽 문서가 남지 않는다).
  const tmp = `${handoffPath(id)}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, handoffPath(id));
}
