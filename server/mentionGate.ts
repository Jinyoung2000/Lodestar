export function mentionCollectionBlocked(env: NodeJS.ProcessEnv = process.env, settings?: { showSlack?: boolean }): boolean {
  if (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") return true;
  return settings !== undefined && settings.showSlack !== true;
}

export function morningReviewAutoBlocked(env: NodeJS.ProcessEnv = process.env, settings?: { showBoard?: boolean }): boolean {
  if (settings !== undefined && settings.showBoard !== true) return true;
  return (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") && env.AGENT_NAV_REVIEW_AUTO !== "1";
}

export function automationsAutoBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") && env.AGENT_NAV_AUTOMATIONS_AUTO !== "1";
}

export function followUpsAutoBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") && env.AGENT_NAV_FOLLOWUPS_AUTO !== "1";
}

export function assistantAutoBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") && env.AGENT_NAV_ASSISTANT_AUTO !== "1";
}
