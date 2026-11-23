import type { MobileModelProvider } from "@shared/mobile";
import type { Harness } from "@shared/protocol";

function claudeName(id: string) {
  const match = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?)?(?:\[1m\])?$/i.exec(id);
  if (!match) return null;
  const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return { family, name: family + (match[2] ? ` ${match[2]}${match[3] ? "." + match[3] : ""}` : "") };
}

export function modelLabel(harness: Harness, id: string, provider?: MobileModelProvider | null, activeId?: string | null) {
  const base = harness === "claude" ? id.replace(/\[1m\]$/i, "") : id;
  const models = provider?.models ?? [];
  const match = models.find(m => m.value === id) ?? models.find(m => m.value === base)
    ?? models.find(m => m.value !== "default" && (m.resolved === id || m.resolved === base));
  if (harness !== "claude") return match?.displayName ?? id;
  const chosen = claudeName(id);
  const active = activeId && claudeName(activeId);
  const resolved = match?.resolved && claudeName(match.resolved);
  if (base === "default") return (resolved && resolved.name) || (active && active.name) || match?.resolved || match?.displayName || id;
  if (chosen && chosen.name === chosen.family && active && active.family === chosen.family && active.name !== active.family) return active.name;
  const label = match?.displayName.trim();
  if (label && !claudeName(label)) return label;
  return (resolved && resolved.name) || chosen?.name || label || id;
}
