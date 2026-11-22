const hooks: Record<string, unknown> = {};

export function exposeHooks(extra: Record<string, unknown>) {
  Object.assign(hooks, extra);
  Object.assign(window, { __agentNav: hooks });
}
