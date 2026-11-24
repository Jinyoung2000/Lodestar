import { HARNESS_VALUES, type Harness } from "../shared/protocol";
import { isModel, modelPinKey, type PickerModel } from "../shared/modelChoices";

export { carryLevel, claudeModels, isModel, providerModels, toolModels, type PickerModel } from "../shared/modelChoices";

export type SourceKey = Harness | `p:${string}`;
export type ProviderTab = "pinned" | SourceKey;
export const PROVIDER_TABS: readonly ProviderTab[] = ["pinned", ...HARNESS_VALUES];

export const sourceOf = (tool: Harness, providerId: string | null | undefined): SourceKey => (providerId ? `p:${providerId}` : tool);
export const providerIdOf = (source: ProviderTab): string | null => (source.startsWith("p:") ? source.slice(2) : null);
export const toolOfSource = (source: SourceKey): Harness => (source.startsWith("p:") ? "claude" : (source as Harness));

export type Provider = { tool: Harness; providerId?: string | null; name?: string; models: PickerModel[]; status: string | null };
export type PickerRow =
  | { kind: "header"; tool: Harness; providerId?: string | null; name?: string }
  | { kind: "status"; tool: Harness; providerId?: string | null; text: string }
  | { kind: "model"; model: PickerModel }
  | { kind: "custom"; tool: Harness; value: string };
export type ChoiceRow = Extract<PickerRow, { kind: "model" | "custom" }>;

const CUSTOM_NAME = /^[\w.[\]:/-]+$/;

export const pinKey = modelPinKey;

const providerSource = (provider: Provider) => sourceOf(provider.tool, provider.providerId);
export const rowSource = (row: ChoiceRow): SourceKey => (row.kind === "model" ? sourceOf(row.model.tool, row.model.providerId) : row.tool);

export function rowKey(row: ChoiceRow) {
  return row.kind === "model" ? `${rowSource(row)}:${row.model.value}` : `${row.tool}:custom:${row.value}`;
}

export const rowTool = (row: ChoiceRow): Harness => (row.kind === "model" ? row.model.tool : row.tool);
export const rowProviderId = (row: ChoiceRow): string | null => (row.kind === "model" ? (row.model.providerId ?? null) : null);
export const rowValue = (row: ChoiceRow) => (row.kind === "model" ? row.model.value : row.value);

const matches = (model: PickerModel, query: string) => `${model.displayName} ${model.value}`.toLowerCase().includes(query);
const header = (provider: Provider): PickerRow => ({ kind: "header", tool: provider.tool, ...(provider.providerId ? { providerId: provider.providerId, name: provider.name } : {}) });

function grouped(providers: Provider[], pick: (provider: Provider) => PickerModel[]): PickerRow[] {
  return providers.flatMap((provider) => {
    const models = pick(provider);
    return models.length ? [header(provider), ...models.map((model) => ({ kind: "model" as const, model }))] : [];
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
    const custom = providers.find((p) => p.tool === customTool && !p.providerId);
    if (!exact && custom && !custom.status && CUSTOM_NAME.test(query.trim())) {
      const row: PickerRow = { kind: "custom", tool: customTool, value: query.trim() };
      const start = rows.findIndex((r) => r.kind === "header" && r.tool === customTool && !r.providerId);
      const next = start === -1 ? -1 : rows.findIndex((r, i) => i > start && r.kind === "header");
      if (start === -1) rows.push({ kind: "header", tool: customTool }, row);
      else rows.splice(next === -1 ? rows.length : next, 0, row);
    }
    return rows;
  }
  if (tab === "pinned") {
    return grouped(
      providers.filter((p) => !p.status),
      (p) => pinned.flatMap((key) => p.models.filter((m) => pinKey(m.tool, m.value, m.providerId) === key)),
    );
  }
  const provider = providers.find((p) => providerSource(p) === tab);
  if (!provider) return [];
  if (provider.status) return [header(provider), { kind: "status", tool: provider.tool, providerId: provider.providerId, text: provider.status }];
  return [header(provider), ...provider.models.map((model) => ({ kind: "model" as const, model }))];
}

export const choiceRows = (rows: PickerRow[]): ChoiceRow[] => rows.filter((r): r is ChoiceRow => r.kind === "model" || r.kind === "custom");

export function stepTab(tab: ProviderTab, direction: 1 | -1, tabs: readonly ProviderTab[] = PROVIDER_TABS): ProviderTab {
  const index = tabs.indexOf(tab);
  return tabs[(index + direction + tabs.length) % tabs.length];
}

export function landingKey(rows: ChoiceRow[], wanted: [SourceKey, string | null][]): string | null {
  for (const [source, value] of wanted) {
    const row = rows.find((r) => r.kind === "model" && rowSource(r) === source && isModel(r.model, value));
    if (row) return rowKey(row);
  }
  return rows[0] ? rowKey(rows[0]) : null;
}
