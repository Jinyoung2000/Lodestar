import { randomUUID } from "node:crypto";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, QuickContext, QuickRun, ServerEvent, TimelineItem } from "../shared/protocol";
import { claudeBin, claudeEnv, claudeErrorText, isAuthError } from "./claude";
import type { AgentRunner } from "./agents";
import { defaultsReader } from "./defaults";
import type { Store } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MAX_RUNS = 20;
// 취소한 뒤 result 가 오지 않을 때 프로세스를 닫기까지의 시간
const CANCEL_GRACE_MS = 10_000;

// 선택한 코드에 대한 일회성 질문. 세션 목록에 들어가지 않고, Read 말고는 도구를 쓰지 않는다.
// 전역 설정(settingSources)을 비워 사용자의 훅과 허용 목록이 돌지 않게 하고, 시스템 프롬프트도 짧게 둔다.
// 인증은 설정과 무관하게 키체인 로그인을 쓴다.
const SYSTEM_PROMPT = [
  "너는 에디터 옆에 붙은 짧은 코드 질문 도우미다.",
  "사용자가 선택한 코드와 파일 경로, 줄 범위가 질문에 들어 있다.",
  "선택한 코드만으로 답할 수 있으면 도구를 쓰지 말고 바로 답한다. 주변 코드가 꼭 필요할 때만 Read 로 그 파일을 읽는다.",
  "답은 한국어로, 핵심만 짧게. 코드 인용은 필요한 줄만.",
].join("\n");

export class QuickRunner {
  private runs = new Map<string, QuickRun>();
  private queries = new Map<string, Query>();

  constructor(
    private store: Store,
    private agents: AgentRunner,
    private emit: (event: ServerEvent) => void,
  ) {}

  ask(id: string, workspaceId: string, model: string, question: string, context: QuickContext) {
    const workspace = this.store.workspace(workspaceId);
    const run: QuickRun = { id, workspaceId, model, question, context, answer: "", status: "running", sessionId: null };
    this.remember(run);
    this.publish(run);

    const q = query({
      prompt: composePrompt(question, context),
      options: {
        cwd: workspace.dir,
        env: claudeEnv(),
        model,
        maxTurns: 4,
        tools: ["Read"],
        settingSources: [],
        systemPrompt: SYSTEM_PROMPT,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeBin(),
        spawnClaudeCodeProcess: spawnInGroup,
        canUseTool: async (toolName, input) =>
          toolName === "Read"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: T.errQuickOnlyRead },
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

  // 빠른 질문 세션을 정식 에이전트로 올린다. 같은 session_id 를 resume 하므로 답변 맥락이 이어진다.
  adopt(id: string): Agent {
    const run = this.runs.get(id);
    if (!run) throw new Error(T.errQuickRunMissing);
    if (!run.sessionId) throw new Error(T.errSessionNotCreated);
    const now = new Date().toISOString();
    const workspace = this.store.workspace(run.workspaceId);
    const defaults = defaultsReader.resolve(this.store.settings);
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      cwd: workspace.dir,
      worktree: null,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: null,
      feedbackId: null,
      title: run.question.replace(/\s+/g, " ").trim().slice(0, 60),
      sessionId: run.sessionId,
      status: "idle",
      permissionMode: defaults.permissionMode.value,
      model: run.model,
      effort: defaults.effort.value,
      activeModel: null,
      activeEffort: null,
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
    };
    const items: TimelineItem[] = [
      { id: randomUUID(), kind: "user", text: composePrompt(run.question, run.context), source: "user" },
      { id: randomUUID(), kind: "assistant", text: run.answer, streaming: false },
    ];
    this.agents.adopt(agent, items);
    return agent;
  }

  private async consume(run: QuickRun, q: Query) {
    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          run.sessionId = message.session_id;
        } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            run.answer += event.delta.text;
            this.publish(run);
          }
        } else if (message.type === "assistant" && !message.parent_tool_use_id) {
          // 스트리밍 조각을 모은 결과와 최종 텍스트가 같아야 하지만, 도구를 쓴 경우 앞 조각이 섞일 수 있어 최종 텍스트로 맞춘다.
          const text = message.message.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) run.answer = run.answer.endsWith(text) ? run.answer : text;
        } else if (message.type === "result") {
          run.status = message.is_error ? "error" : "done";
          if (message.is_error && !run.answer) run.answer = T.noAnswer;
        }
      }
      if (run.status === "running") run.status = "done";
    } catch (error) {
      run.status = "error";
      const text = claudeErrorText(String(error));
      run.answer = isAuthError(text) ? T.reloginHint(text) : text;
    } finally {
      this.queries.delete(run.id);
      this.publish(run);
    }
  }

  private remember(run: QuickRun) {
    this.runs.set(run.id, run);
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private publish(run: QuickRun) {
    this.emit({ type: "quick", run: { ...run } });
  }
}

export function composePrompt(question: string, context: QuickContext) {
  const range = T.quickLines(context.startLine, context.endLine);
  const lang = context.path.slice(context.path.lastIndexOf(".") + 1);
  return `${context.path} ${range}\n\`\`\`${lang}\n${context.text}\n\`\`\`\n\n${question}`;
}
