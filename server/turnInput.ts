import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class PushQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(message: SDKUserMessage) {
    this.items.push(message);
    this.wake?.();
  }

  remove(uuid: string) {
    const index = this.items.findIndex((m) => m.uuid === uuid);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  close() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

export function userMessage(text: string, uuid: string, priority?: "now" | "next", images: UserImageBlock[] = []): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: uuid as SDKUserMessage["uuid"], ...(priority ? { priority } : {}) };
}

export type UserImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

export function isControlEcho(message: SDKMessage) {
  if (message.type !== "user") return false;
  const content = message.message.content;
  const starts = (text: string) => text.startsWith("[Request interrupted by user") || /^<local-command-std(out|err)>/.test(text);
  return typeof content === "string" ? starts(content) : content.some((block) => block.type === "text" && starts(block.text));
}

export type TurnEnd = "continue" | "steered" | "ok" | "error" | "interrupted";

export function turnEnd(result: { interrupted: boolean; queuedTurnCount?: number; isError: boolean; pendingSteers?: number; uuidsKnown?: boolean }): TurnEnd {
  const more = (result.queuedTurnCount ?? 0) > 0;
  if (result.interrupted) return more ? "continue" : "interrupted";
  if (more) return "continue";
  if ((result.pendingSteers ?? 0) > 0 && result.uuidsKnown) return "steered";
  return result.isError ? "error" : "ok";
}

export function ownsTurn(turnMessageId: string | null, userMessageUuids: string[] | undefined) {
  return turnMessageId !== null && (userMessageUuids?.includes(turnMessageId) ?? true);
}

export function consumedUuids(frame: { user_message_uuid?: string; user_message_uuids?: string[] }) {
  return frame.user_message_uuids ?? (frame.user_message_uuid ? [frame.user_message_uuid] : undefined);
}

export function splitSteering<T extends { id: string }>(steering: T[] | undefined, uuids: string[] | undefined): { taken: T[]; rest: T[] } {
  const list = steering ?? [];
  const taken = uuids?.length ? list.filter((s) => uuids.includes(s.id)) : [];
  return { taken, rest: list.filter((s) => !taken.includes(s)) };
}
