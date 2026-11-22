import { existsSync, openSync, readdirSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { composeTermPrompt, PROJECT_FILES, projectSummary, TERM_ASK_SYSTEM_PROMPT, type ProjectFile, type TermAskContext } from "../shared/termAsk";
import type { ServerEvent, TermAskRun } from "../shared/protocol";
import { claudeBin, claudeEnv, isAuthError } from "./claude";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MAX_RUNS = 20;

export class TermAskRunner {
  private runs = new Map<string, TermAskRun>();
  private queries = new Map<string, Query>();

  constructor(private emit: (event: ServerEvent) => void) {}

  ask(id: string, model: string, question: string, context: TermAskContext) {
    const run: TermAskRun = { id, model, question, answer: "", status: "running" };
    this.runs.set(id, run);
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    this.publish(run);

    const q = query({
      prompt: composeTermPrompt(question, { ...context, project: projectSummary(readProjectFiles(context.cwd)) }),
      options: {
        cwd: existsSync(context.cwd) ? context.cwd : homedir(),
        env: claudeEnv(),
        model,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        systemPrompt: TERM_ASK_SYSTEM_PROMPT,
        persistSession: false,
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
    void this.queries.get(id)?.interrupt();
  }

  private async consume(run: TermAskRun, q: Query) {
    try {
      for await (const message of q) {
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            run.answer += event.delta.text;
            this.publish(run);
          }
        } else if (message.type === "assistant" && !message.parent_tool_use_id) {
          const text = message.message.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) run.answer = text;
        } else if (message.type === "result") {
          run.status = message.is_error ? "error" : "done";
          if (message.is_error && !run.answer) run.answer = T.noAnswer;
        }
      }
      if (run.status === "running") run.status = "done";
    } catch (error) {
      run.status = "error";
      const text = String(error);
      run.answer = isAuthError(text) ? T.reloginHint(text) : text;
    } finally {
      this.queries.delete(run.id);
      this.publish(run);
    }
  }

  private publish(run: TermAskRun) {
    this.emit({ type: "termask", run: { ...run } });
  }
}

const MAX_PROJECT_FILE_BYTES = 64 * 1024;

function readProjectFiles(cwd: string): ProjectFile[] {
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return [];
  }
  return names
    .filter((name) => Object.hasOwn(PROJECT_FILES, name))
    .map((name) => ({ name, text: PROJECT_FILES[name] ? readHead(join(cwd, name)) : null }));
}

function readHead(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(MAX_PROJECT_FILE_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
