import type { Agent } from "../shared/protocol";

export function forkedFrom(source: Agent): Agent {
  const { automationId: _automationId, ...rest } = source;
  return { ...rest, queue: [] };
}
