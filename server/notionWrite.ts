import { rejectionMessage } from "../shared/notionWrite";
import type { NotionWriteResult } from "./notion";

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

export function writeResultText(outcome: GatedOutcome): string {
  if (!outcome.sent) return outcome.text;
  const body = outcome.text.trim().slice(0, 1500);
  return outcome.isError ? `Notion rejected the change. Nothing was written.\n${body}` : `Applied to Notion.${body ? `\n${body}` : ""}`;
}
