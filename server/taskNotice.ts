import type { TimelineItem } from "../shared/protocol";

export function showsTaskNotice(status: "completed" | "failed" | "stopped", tool: TimelineItem | undefined): boolean {
  if (status === "stopped") return false;
  if (!tool || tool.kind !== "tool") return true;
  return tool.input.run_in_background === true;
}
