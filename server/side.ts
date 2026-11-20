import { randomUUID } from "node:crypto";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, ServerEvent, SideRun, TimelineItem } from "../shared/protocol";
import { claudeBin, claudeEnv, claudeErrorText, isAuthError } from "./claude";
import type { AgentRunner } from "./agents";
import { forkedFrom } from "./forkAgent";
import type { Store } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MAX_RUNS = 20;
// 취소한 뒤 result 가 오지 않을 때 프로세스를 닫기까지의 시간
const CANCEL_GRACE_MS = 10_000;
const SIDE_MAX_TURNS = 8;

// /btw 사이드 챗. 메인 세션을 forkSession 으로 갈라 그 대화 기록을 들고 가되, 메인 jsonl 과 타임라인은 건드리지 않는다.
// 메인 턴이 실행 중이어도 갈라진다 (스파이크 .verify/spike/fork.ts 로 확인). 도구는 쓰지 않고 짧게 답한다.
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
  ) {}

  ask(id: string, agentId: string, model: string, question: string) {
    const agent = this.store.agent(agentId);
    if (!agent.sessionId) throw new Error(T.errMainNotStarted);
    let run = this.runs.get(id);
    if (!run) {
      run = { id, agentId, model, sessionId: null, messages: [], status: "idle" };
      this.remember(run);
    }
    if (run.status === "running") throw new Error(T.errWaitingForAnswer);
    run.model = model;
    run.messages.push({ role: "user", text: question }, { role: "assistant", text: "" });
    run.status = "running";
    this.publish(run);

    // 첫 질문은 메인 세션에서 갈라지고(forkSession), 그 뒤는 갈라진 세션을 그대로 이어 간다.
    const q = query({
      prompt: question,
      options: {
        cwd: agent.cwd,
        env: claudeEnv(),
        model,
        resume: run.sessionId ?? agent.sessionId,
        forkSession: run.sessionId ? undefined : true,
        // 코드 사실을 묻는 곁다리 질문이 많아 읽기 도구만 연다(쓰기와 실행은 없음). 도구 왕복마다 턴이 하나씩 들어서 2 로는 한 번 읽고 끝나 버렸다(사용자 10-20 "Reached maximum number of turns (2)").
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

  // 중단 요청은 프로세스가 답하기 전에 끝나면 거절된다(답이 막 끝난 순간의 취소). 잡지 않은 거절은 데몬을 죽인다.
  // 답이 없는 프로세스는 잠시 뒤 닫아서 "답하는 중" 으로 남지 않게 한다(남으면 데몬 재시작 판단이 계속 바쁨으로 본다).
  cancel(id: string) {
    const q = this.queries.get(id);
    if (!q) return;
    void q.interrupt().catch(() => undefined);
    setTimeout(() => {
      if (this.queries.get(id) === q) q.close();
    }, CANCEL_GRACE_MS).unref();
  }

  // 사이드 챗을 정식 갈래 세션으로 남긴다. 메인 타임라인을 복사하고 사이드 대화를 뒤에 붙인다.
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
      // 턴 한도에 걸리면 SDK 가 예외로 끝낸다. 그때까지 쓴 답이 있으면 남기고 한도에 걸렸다고 덧붙인다.
      if (/maximum number of turns/i.test(text)) last().text = last().text ? `${last().text}\n\n${T.sideTurnLimit}` : T.sideTurnLimit;
      else last().text = isAuthError(text) ? T.reloginHint(text) : text;
    } finally {
      this.queries.delete(run.id);
      this.publish(run);
    }
  }

  private remember(run: SideRun) {
    this.runs.set(run.id, run);
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private publish(run: SideRun) {
    this.emit({ type: "side", run: { ...run, messages: run.messages.map((m) => ({ ...m })) } });
  }
}
