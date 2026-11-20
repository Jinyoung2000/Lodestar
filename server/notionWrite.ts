import { rejectionMessage } from "../shared/notionWrite";
import type { NotionWriteResult } from "./notion";

// Notion 쓰기의 승인 관문. 이 파일의 gatedWrite 가 Notion 쓰기 호출이 나가는 유일한 길이다.
//  - ask 는 사용자에게 변경을 보여 주고 결정을 기다린다. 허용(allowed === true)이 아니면 run 은 부르지 않는다.
//  - ask 가 예외를 던지거나 끝나지 않으면 쓰기는 나가지 않는다 (예외는 거절로 본다).
//  - 승인은 이 호출 한 번에만 쓰인다. args 는 승인 시점의 사본을 쓰므로, 묻는 동안 원본이 바뀌어도 승인한 내용이 그대로 나간다.

export type WriteApproval = { allowed: boolean; feedback?: string };
export type WriteTool = "notion-update-page" | "notion-create-pages";

export type GatedWrite = { tool: WriteTool; args: Record<string, unknown>; ask: () => Promise<WriteApproval>; run: (tool: WriteTool, args: Record<string, unknown>) => Promise<NotionWriteResult> };

export type GatedOutcome = { sent: false; text: string; reason: "rejected" | "ask-failed" } | { sent: true; text: string; isError: boolean; costUsd: number | null };

export async function gatedWrite(request: GatedWrite): Promise<GatedOutcome> {
  const frozen = structuredClone(request.args);
  let approval: WriteApproval;
  try {
    approval = await request.ask();
  } catch {
    return { sent: false, text: rejectionMessage(), reason: "ask-failed" };
  }
  if (approval.allowed !== true) return { sent: false, text: rejectionMessage(approval.feedback), reason: "rejected" };
  const result = await request.run(request.tool, frozen);
  return { sent: true, text: result.text, isError: result.isError, costUsd: result.costUsd };
}

// 모델에게 돌려주는 도구 결과 글
export function writeResultText(outcome: GatedOutcome): string {
  if (!outcome.sent) return outcome.text;
  const body = outcome.text.trim().slice(0, 1500);
  return outcome.isError ? `Notion rejected the change. Nothing was written.\n${body}` : `Applied to Notion.${body ? `\n${body}` : ""}`;
}
