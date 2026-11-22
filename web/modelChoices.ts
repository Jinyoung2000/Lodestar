import { CLAUDE_EFFORT_LEVELS, HARNESS_VALUES, type CodexMeta, type EffortLevel, type Harness, type ModelInfo } from "../shared/protocol";

export type ProviderTab = "pinned" | Harness;
export const PROVIDER_TABS: readonly ProviderTab[] = ["pinned", ...HARNESS_VALUES];

export type PickerModel = { tool: Harness; value: string; resolved: string | null; displayName: string; levels: EffortLevel[]; defaultLevel: EffortLevel | null; isDefault: boolean };
export type Provider = { tool: Harness; models: PickerModel[]; status: string | null };
export type PickerRow = { kind: "header"; tool: Harness } | { kind: "status"; tool: Harness; text: string } | { kind: "model"; model: PickerModel } | { kind: "custom"; tool: Harness; value: string };
export type ChoiceRow = Extract<PickerRow, { kind: "model" | "custom" }>;

const CLAUDE_BUILTIN_LEVEL: EffortLevel = "high";
const CUSTOM_NAME = /^[\w.[\]:/-]+$/;

export function claudeModels(models: ModelInfo[], defaultModel: string | null): PickerModel[] {
  return models.map((m) => {
    const levels = m.supportedEffortLevels.length ? m.supportedEffortLevels : [...CLAUDE_EFFORT_LEVELS];
    return {
      tool: "claude",
      value: m.value,
      resolved: m.resolvedModel,
      displayName: m.displayName,
      levels,
      defaultLevel: levels.includes(CLAUDE_BUILTIN_LEVEL) ? CLAUDE_BUILTIN_LEVEL : (levels.at(-1) ?? null),
      isDefault: m.value !== "default" && m.value === defaultModel,
    };
  });
}

export function toolModels(tool: Harness, meta: CodexMeta | null): PickerModel[] {
  const fallback = meta?.defaultModel ?? meta?.models.find((m) => m.isDefault)?.value ?? null;
  return (meta?.models ?? []).map((m) => ({
    tool,
    value: m.value,
    resolved: null,
    displayName: m.displayName,
    levels: m.supportedEffortLevels,
    defaultLevel: m.defaultEffort ?? (m.value === fallback ? (meta?.defaultEffort ?? null) : null),
    isDefault: m.value === fallback,
  }));
}

export const isModel = (model: PickerModel, value: string | null) => value !== null && (model.value === value || model.resolved === value);

export const pinKey = (tool: Harness, value: string) => (tool === "claude" ? value : `${tool}:${value}`);

export function rowKey(row: ChoiceRow) {
  return row.kind === "model" ? `${row.model.tool}:${row.model.value}` : `${row.tool}:custom:${row.value}`;
}

export const rowTool = (row: ChoiceRow): Harness => (row.kind === "model" ? row.model.tool : row.tool);
export const rowValue = (row: ChoiceRow) => (row.kind === "model" ? row.model.value : row.value);

const matches = (model: PickerModel, query: string) => `${model.displayName} ${model.value}`.toLowerCase().includes(query);

function grouped(providers: Provider[], pick: (provider: Provider) => PickerModel[]): PickerRow[] {
  return providers.flatMap((provider) => {
    const models = pick(provider);
    return models.length ? [{ kind: "header" as const, tool: provider.tool }, ...models.map((model) => ({ kind: "model" as const, model }))] : [];
  });
}

export function pickerRows(providers: Provider[], tab: ProviderTab, query: string, pinned: readonly string[], customTool: Harness): PickerRow[] {
  const q = query.trim().toLowerCase();
  if (q) {
    const rows = grouped(
      providers.filter((p) => !p.status),
      (p) => p.models.filter((m) => matches(m, q)),
    );
    const exact = providers.some((p) => p.models.some((m) => m.value.toLowerCase() === q || m.displayName.toLowerCase() === q));
    const custom = providers.find((p) => p.tool === customTool);
    if (!exact && custom && !custom.status && CUSTOM_NAME.test(query.trim())) {
      const row: PickerRow = { kind: "custom", tool: customTool, value: query.trim() };
      const start = rows.findIndex((r) => r.kind === "header" && r.tool === customTool);
      const next = start === -1 ? -1 : rows.findIndex((r, i) => i > start && r.kind === "header");
      if (start === -1) rows.push({ kind: "header", tool: customTool }, row);
      else rows.splice(next === -1 ? rows.length : next, 0, row);
    }
    return rows;
  }
  if (tab === "pinned") {
    return grouped(
      providers.filter((p) => !p.status),
      (p) => pinned.flatMap((key) => p.models.filter((m) => pinKey(m.tool, m.value) === key)),
    );
  }
  const provider = providers.find((p) => p.tool === tab);
  if (!provider) return [];
  if (provider.status) return [{ kind: "header", tool: tab }, { kind: "status", tool: tab, text: provider.status }];
  return [{ kind: "header", tool: tab }, ...provider.models.map((model) => ({ kind: "model" as const, model }))];
}

export const choiceRows = (rows: PickerRow[]): ChoiceRow[] => rows.filter((r): r is ChoiceRow => r.kind === "model" || r.kind === "custom");

export function carryLevel(current: EffortLevel | null, levels: readonly EffortLevel[], fallback: EffortLevel | null): EffortLevel | null {
  if (levels.length === 0) return null;
  return current && levels.includes(current) ? current : fallback;
}

export function stepTab(tab: ProviderTab, direction: 1 | -1): ProviderTab {
  const index = PROVIDER_TABS.indexOf(tab);
  return PROVIDER_TABS[(index + direction + PROVIDER_TABS.length) % PROVIDER_TABS.length];
}

export function landingKey(rows: ChoiceRow[], wanted: [Harness, string | null][]): string | null {
  for (const [tool, value] of wanted) {
    const row = rows.find((r) => r.kind === "model" && r.model.tool === tool && isModel(r.model, value));
    if (row) return rowKey(row);
  }
  return rows[0] ? rowKey(rows[0]) : null;
}
