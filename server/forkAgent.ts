import type { Agent } from "../shared/protocol";

export function forkedFrom(source: Agent): Agent {
  return { ...source, queue: [] };
}
