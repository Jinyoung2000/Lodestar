import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEffort, type Agent, type EffortLevel, type ServerEvent, type SideRun, type TimelineItem } from "../shared/protocol";
import { claudeBin, claudeEnv, claudeErrorText, isAuthError } from "./claude";
import type { AgentRunner } from "./agents";
import { forkedFrom } from "./forkAgent";
import { HOME, writeFileAtomic, type Store } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MAX_RUNS = 200;
const SIDE_FILE = join(HOME, "side-chats.json");
const CANCEL_GRACE_MS = 10_000;
const SIDE_MAX_TURNS = 8;

const SYSTEM_PROMPT = [
  "너는 진행 중인 코딩 세션 옆에 붙은 곁다리 질문 창이다. 앞선 대화 기록을 그대로 알고 있다.",
  "대화 내용으로 답할 수 있으면 도구 없이 답한다. 코드를 확인해야 하면 Read, Grep, Glob 으로 몇 번만 읽고, 파일을 고치거나 명령을 실행하지 않는다. 한국어로 짧게 답하고, 모르면 모른다고 한다.",
].join("\n");

export class SideRunner {
  private runs = new Map<string, SideRun>();
  private queries = new Map<string, Query>();

  constructor(
    private store: Store,
    private agents: AgentRunner,
    private emit: (event: ServerEvent) => void,
  ) {
    for (const run of loadSaved()) this.runs.set(run.id, run);
  }

  list(agentId: string): SideRun[] {
    return [...this.runs.values()]
      .filter((run) => run.agentId === agentId && run.messages.length > 0)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map(copyRun);
  }

  ask(id: string, agentId: string, model: string, effort: EffortLevel | null, question: string) {
    const agent = this.store.agent(agentId);
    if (!agent.sessionId) throw new Error(T.errMainNotStarted);
    let run = this.runs.get(id);
    if (!run) {
      run = { id, agentId, model, sessionId: null, messages: [], status: "idle" };
    }
    if (run.status === "running") throw new Error(T.errWaitingForAnswer);
    this.remember(run);
    run.model = model;
    run.effort = effort;
    run.updatedAt = new Date().toISOString();
    run.messages.push({ role: "user", text: question }, { role: "assistant", text: "" });
    run.status = "running";
    this.publish(run);

    const q = query({
      prompt: question,
      options: {
        cwd: agent.cwd,
        env: claudeEnv(),
        model,
        effort: claudeEffort(effort) ?? undefined,
        resume: run.sessionId ?? agent.sessionId,
        forkSession: run.sessionId ? undefined : true,
        maxTurns: SIDE_MAX_TURNS,
        tools: ["Read", "Grep", "Glob"],
        allowedTools: ["Read", "Grep", "Glob"],
        settingSources: [],
        systemPrompt: SYSTEM_PROMPT,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeBin(),
        spawnClaudeCodeProcess: spawnInGroup,
      },
    });
    this.queries.set(id, q);
    void this.consume(run, q);
  }

  activeCount() {
    return this.queries.size;
  }

  cancel(id: string) {
    const q = this.queries.get(id);
    if (!q) return;
    void q.interrupt().catch(() => undefined);
    setTimeout(() => {
      if (this.queries.get(id) === q) q.close();
    }, CANCEL_GRACE_MS).unref();
  }

  adopt(id: string): Agent {
    const run = this.runs.get(id);
    if (!run) throw new Error(T.errSideRunMissing);
    if (!run.sessionId) throw new Error(T.errSessionNotCreated);
    const source = this.store.agent(run.agentId);
    const now = new Date().toISOString();
    const agent: Agent = {
      ...forkedFrom(source),
      id: randomUUID(),
      title: `Forked: ${source.title}`,
      sessionId: run.sessionId,
      resumeFrom: null,
      forkedFrom: source.id,
      sideAdopted: true,
      feedbackId: null,
      model: run.model,
      status: "idle",
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
    };
    const items: TimelineItem[] = [
      ...this.store.timeline(source.id).filter((i) => !(i.kind === "assistant" && i.streaming)).map((i) => ({ ...i, id: `${agent.id.slice(0, 8)}:${i.id}` })),
      ...run.messages.map((m): TimelineItem =>
        m.role === "user" ? { id: randomUUID(), kind: "user", text: m.text, source: "user" } : { id: randomUUID(), kind: "assistant", text: m.text, streaming: false },
      ),
    ];
    this.agents.adopt(agent, items);
    return agent;
  }

  private async consume(run: SideRun, q: Query) {
    const last = () => run.messages[run.messages.length - 1];
    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          run.sessionId = message.session_id;
        } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            last().text += event.delta.text;
            this.publish(run);
          }
        } else if (message.type === "assistant" && !message.parent_tool_use_id) {
          const text = message.message.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) last().text = text;
        } else if (message.type === "result") {
          run.status = message.is_error ? "error" : "idle";
          if (message.is_error && !last().text) last().text = T.noAnswer;
        }
      }
      if (run.status === "running") run.status = "idle";
    } catch (error) {
      run.status = "error";
      const text = claudeErrorText(String(error));
      if (/maximum number of turns/i.test(text)) last().text = last().text ? `${last().text}\n\n${T.sideTurnLimit}` : T.sideTurnLimit;
      else last().text = isAuthError(text) ? T.reloginHint(text) : text;
    } finally {
      this.queries.delete(run.id);
      run.updatedAt = new Date().toISOString();
      this.publish(run);
      this.save();
    }
  }

  private remember(run: SideRun) {
    this.runs.delete(run.id);
    this.runs.set(run.id, run);
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private save() {
    const alive = new Set(this.store.agents.map((agent) => agent.id));
    const done = [...this.runs.values()].filter((run) => run.status !== "running" && run.messages.length > 0 && alive.has(run.agentId));
    try {
      writeFileAtomic(SIDE_FILE, JSON.stringify(done));
    } catch (error) {
      console.error(`[side] could not save side chats: ${(error as Error).message}`);
    }
  }

  private publish(run: SideRun) {
    this.emit({ type: "side", run: copyRun(run) });
  }
}

function copyRun(run: SideRun): SideRun {
  return { ...run, messages: run.messages.map((m) => ({ ...m })) };
}

function loadSaved(): SideRun[] {
  if (!existsSync(SIDE_FILE)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(SIDE_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((run): run is SideRun => typeof run?.id === "string" && typeof run.agentId === "string" && Array.isArray(run.messages))
      .map((run) => ({ ...run, status: run.status === "running" ? "idle" : run.status }));
  } catch (error) {
    console.error(`[side] could not read ${SIDE_FILE}: ${(error as Error).message}`);
    return [];
  }
}
