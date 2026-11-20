// B3: 세션 프로세스(CLI)로 들어가는 입력과 턴 경계 판단. SDK 와 데몬 상태에 기대지 않는 순수한 조각이라 test/queue.test.ts 가 따로 시험한다.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// B3: 세션 프로세스에 메시지를 흘려 넣는 입력. 닫을 때까지 끝나지 않는 AsyncIterable 이라 프로세스가 세션 동안 살아 있다.
export class PushQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(message: SDKUserMessage) {
    this.items.push(message);
    this.wake?.();
  }

  // QUEUECANCEL: 아직 CLI 로 넘어가지 않은 메시지를 뺀다. 이미 꺼내 간 것이면 false.
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

// 사용자 메시지. 문자열 프롬프트는 CLI 가 uuid 를 정해서 우리가 알 수 없으므로, uuid 를 담은 메시지로 보낸다. 글은 그대로이고 아무것도 덧붙이지 않는다.
// priority 는 진행 중인 턴에 끼어들 때만 둔다.
// fixB: images 가 있으면 content 가 글 블록(글이 있을 때만)과 image 블록의 배열이 된다. 빈 글 블록은 API 가 거절한다.
export function userMessage(text: string, uuid: string, priority?: "now" | "next", images: UserImageBlock[] = []): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: uuid as SDKUserMessage["uuid"], ...(priority ? { priority } : {}) };
}

export type UserImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

// CLI 가 제어 동작에 대해 남기는 안내 프레임: 중단("[Request interrupted by user]")과 모델 바꾸기 같은 로컬 명령의 출력(<local-command-stdout>).
// 사용자가 보낸 글도 CLI 의 자동 메시지(백그라운드 작업 알림)도 아니라서 대화에 보이지 않고, 턴을 시작하지도 않는다.
export function isControlEcho(message: SDKMessage) {
  if (message.type !== "user") return false;
  const content = message.message.content;
  const starts = (text: string) => text.startsWith("[Request interrupted by user") || /^<local-command-std(out|err)>/.test(text);
  return typeof content === "string" ? starts(content) : content.some((block) => block.type === "text" && starts(block.text));
}

// continue: 끼어들기로 보낸 메시지의 턴이 이어진다(아직 끝이 아니다). steered: 끼어들기를 담지 않은 result 다. 끼어든 메시지가 오기 전 턴이 끝났거나 끊겼다는 뜻이라 끼어든 메시지의 새 턴이 곧 이어진다.
export type TurnEnd = "continue" | "steered" | "ok" | "error" | "interrupted";

// result 하나가 턴의 끝인지. queuedTurnCount 가 0 보다 크면 끼어들기로 보낸 메시지의 턴이 이어지니 아직 끝이 아니다.
// priority now 로 끼어들면 CLI 는 진행 중이던 턴을 마무리(error_during_execution 이나 success)하고 끼어든 메시지의 새 턴을 연다. 그 result 는 끼어든 메시지의 uuid 를 담지 않으므로,
// 아직 result 에 담기지 않은 끼어들기(pendingSteers)가 남아 있으면 끝이 아니다. result 가 uuid 목록을 주지 않는 옛 CLI 는 이 판단을 못 하니 끝으로 본다(uuidsKnown 이 false).
// 끝이라면 어떻게 끝났나: 중단, 오류, 정상. 큐의 다음 메시지는 정상일 때만 보낸다.
export function turnEnd(result: { interrupted: boolean; queuedTurnCount?: number; isError: boolean; pendingSteers?: number; uuidsKnown?: boolean }): TurnEnd {
  const more = (result.queuedTurnCount ?? 0) > 0;
  if (result.interrupted) return more ? "continue" : "interrupted";
  if (more) return "continue";
  if ((result.pendingSteers ?? 0) > 0 && result.uuidsKnown) return "steered";
  return result.isError ? "error" : "ok";
}

// 이 result 가 그 턴을 시작한 메시지의 것인가. user_message_uuids 가 없는 옛 CLI 는 그렇다고 본다.
export function ownsTurn(turnMessageId: string | null, userMessageUuids: string[] | undefined) {
  return turnMessageId !== null && (userMessageUuids?.includes(turnMessageId) ?? true);
}

// 응답 조각(stream_event, assistant)이 담고 있는, 그 턴이 지금까지 받은 사용자 메시지 uuid. 끼어들기 메시지가 대화에 들어갈 시점을 정한다.
export function consumedUuids(frame: { user_message_uuid?: string; user_message_uuids?: string[] }) {
  return frame.user_message_uuids ?? (frame.user_message_uuid ? [frame.user_message_uuid] : undefined);
}

// 끼어들기 대기 목록에서 모델이 받은 것(uuids 에 든 id)을 나눈다. 받은 것만 대화로 옮기고 나머지는 계속 기다린다.
export function splitSteering<T extends { id: string }>(steering: T[] | undefined, uuids: string[] | undefined): { taken: T[]; rest: T[] } {
  const list = steering ?? [];
  const taken = uuids?.length ? list.filter((s) => uuids.includes(s.id)) : [];
  return { taken, rest: list.filter((s) => !taken.includes(s)) };
}
