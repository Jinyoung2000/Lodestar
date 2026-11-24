export type ProviderModel = { id: string; name: string | null };

export type CustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModel[];
  defaultModel: string | null;
  preset: string | null;
};

export type CustomProviderView = CustomProvider & { hasKey: boolean };

export type ProviderPreset = { id: string; name: string; baseUrl: string; keyHint: string };

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "zai", name: "Z.ai GLM", baseUrl: "https://api.z.ai/api/anthropic", keyHint: "GLM Coding Plan key" },
  { id: "moonshot", name: "Moonshot Kimi", baseUrl: "https://api.moonshot.ai/anthropic", keyHint: "Moonshot API key" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", keyHint: "DeepSeek API key" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", keyHint: "MiniMax API key" },
];

export const PROVIDER_LIMITS = { providers: 20, models: 50, name: 40, modelId: 120, url: 300, key: 4096 };

const MODEL_ID = /^[\w.:/@[\]=,-]+$/;
const PROVIDER_ID = /^[a-z0-9-]{1,40}$/;

export const isProviderId = (value: unknown): value is string => typeof value === "string" && PROVIDER_ID.test(value);

export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export type ProviderProblem = "name" | "baseUrl" | "models" | "modelId" | "defaultModel";

export function providerProblem(provider: Pick<CustomProvider, "name" | "baseUrl" | "models" | "defaultModel">): ProviderProblem | null {
  if (!provider.name.trim() || provider.name.trim().length > PROVIDER_LIMITS.name) return "name";
  let url: URL;
  try {
    url = new URL(provider.baseUrl.trim());
  } catch {
    return "baseUrl";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local)) || provider.baseUrl.length > PROVIDER_LIMITS.url) return "baseUrl";
  if (provider.models.length === 0 || provider.models.length > PROVIDER_LIMITS.models) return "models";
  if (provider.models.some((m) => !MODEL_ID.test(m.id) || m.id.length > PROVIDER_LIMITS.modelId)) return "modelId";
  if (provider.defaultModel !== null && !provider.models.some((m) => m.id === provider.defaultModel)) return "defaultModel";
  return null;
}

export function cleanProvider(raw: unknown): CustomProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isProviderId(value.id) || typeof value.name !== "string" || typeof value.baseUrl !== "string" || !Array.isArray(value.models)) return null;
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of value.models) {
    const item = entry as Record<string, unknown> | null;
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : null;
    models.push({ id, name });
  }
  const provider: CustomProvider = {
    id: value.id,
    name: value.name.trim(),
    baseUrl: value.baseUrl.trim().replace(/\/+$/, ""),
    models,
    defaultModel: typeof value.defaultModel === "string" && seen.has(value.defaultModel) ? value.defaultModel : (models[0]?.id ?? null),
    preset: typeof value.preset === "string" && PROVIDER_PRESETS.some((p) => p.id === value.preset) ? value.preset : null,
  };
  return providerProblem(provider) ? null : provider;
}

export const providerModelName = (provider: CustomProvider, id: string) => provider.models.find((m) => m.id === id)?.name ?? id;
