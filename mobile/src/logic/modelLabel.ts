import type { MobileModelProvider } from "@shared/mobile";
import type { Harness } from "@shared/protocol";

function claudeName(id: string) {
  const match = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?)?(?:\[1m\])?$/i.exec(id);
  if (!match) return null;
  const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return { family, name: family + (match[2] ? ` ${match[2]}${match[3] ? "." + match[3] : ""}` : "") };
}

function familyName(family: string, models: MobileModelProvider["models"]) {
  let best: { name: string; version: number } | null = null;
  for (const model of models) {
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/i.exec(model.resolved ?? model.value);
    const parsed = match && claudeName((model.resolved ?? model.value).replace(/\[[^\]]*\]$/, ""));
    if (!match || !parsed || parsed.family !== family || parsed.name === parsed.family) continue;
    const version = Number(match[2]) * 100 + Number(match[3] ?? 0);
    if (!best || version > best.version) best = { name: parsed.name, version };
  }
  return best?.name ?? null;
}

export function fallbackEffort<T extends string>(levels: readonly T[]): T | null {
  return levels.find((level) => level === "high") ?? levels[levels.length - 1] ?? null;
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
  if (resolved) return resolved.name;
  if (chosen && chosen.name === chosen.family) return familyName(chosen.family, models) ?? chosen.name;
  return chosen?.name || label || id;
}
