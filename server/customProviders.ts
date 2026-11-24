import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanProvider, isProviderId, PROVIDER_LIMITS, providerProblem, type CustomProvider, type CustomProviderView, type ProviderModel } from "../shared/customProviders";
import { deleteProviderKey, readProviderKey, saveProviderKey } from "./keychain";
import { HOME, writeFileAtomic } from "./store";
import { T } from "./strings";

const FILE = join(HOME, "custom-providers.json");
const MODELS_TIMEOUT_MS = 15_000;

export type ProviderInput = Omit<CustomProvider, "id"> & { id: string | null };

function readFile(): CustomProvider[] {
  if (!existsSync(FILE)) return [];
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as { providers?: unknown };
    return (Array.isArray(saved.providers) ? saved.providers : []).map(cleanProvider).filter((p): p is CustomProvider => p !== null).slice(0, PROVIDER_LIMITS.providers);
  } catch (error) {
    console.error("[providers] could not read custom-providers.json", error);
    return [];
  }
}

export class CustomProviders {
  private providers = readFile();
  private keyKnown = new Map<string, boolean>();

  constructor(private onChange: (views: CustomProviderView[]) => void) {}

  get(id: string | null | undefined): CustomProvider | null {
    return id ? (this.providers.find((p) => p.id === id) ?? null) : null;
  }

  all(): CustomProvider[] {
    return this.providers;
  }

  async views(): Promise<CustomProviderView[]> {
    return Promise.all(this.providers.map(async (provider) => ({ ...provider, hasKey: await this.hasKey(provider.id) })));
  }

  private async hasKey(id: string) {
    const known = this.keyKnown.get(id);
    if (known !== undefined) return known;
    const found = await readProviderKey(id).then((key) => key !== null, () => false);
    this.keyKnown.set(id, found);
    return found;
  }

  async keyFor(id: string): Promise<string | null> {
    const key = await readProviderKey(id);
    this.keyKnown.set(id, key !== null);
    return key;
  }

  async save(input: ProviderInput, key: string | null | undefined): Promise<CustomProviderView[]> {
    const id = input.id ?? randomUUID().slice(0, 8);
    if (!isProviderId(id)) throw new Error(T.providerInvalid("name"));
    const existing = this.providers.findIndex((p) => p.id === id);
    if (existing === -1 && input.id !== null) throw new Error(T.providerMissing);
    if (existing === -1 && this.providers.length >= PROVIDER_LIMITS.providers) throw new Error(T.providerTooMany(PROVIDER_LIMITS.providers));
    const problem = providerProblem(input);
    if (problem) throw new Error(T.providerInvalid(problem));
    const provider = cleanProvider({ ...input, id });
    if (!provider) throw new Error(T.providerInvalid("models"));
    if (typeof key === "string" && key.trim()) {
      await saveProviderKey(id, provider.name, key.trim());
      this.keyKnown.set(id, true);
    } else if (key === null) {
      await deleteProviderKey(id);
      this.keyKnown.set(id, false);
    }
    this.providers = existing === -1 ? [...this.providers, provider] : this.providers.map((p) => (p.id === id ? provider : p));
    this.write();
    return this.publish();
  }

  async remove(id: string): Promise<CustomProviderView[]> {
    if (!this.get(id)) return this.views();
    await deleteProviderKey(id);
    this.keyKnown.delete(id);
    this.providers = this.providers.filter((p) => p.id !== id);
    this.write();
    return this.publish();
  }

  async loadModels(params: { id: string | null; baseUrl: string; key: string | null }): Promise<ProviderModel[]> {
    const key = params.key?.trim() || (params.id ? await this.keyFor(params.id) : null);
    if (!key) throw new Error(T.providerNoKeyForModels);
    if (providerProblem({ name: "x", baseUrl: params.baseUrl, models: [{ id: "x", name: null }], defaultModel: null }) === "baseUrl") throw new Error(T.providerInvalid("baseUrl"));
    let response: Response;
    try {
      response = await fetch(`${params.baseUrl.trim().replace(/\/+$/, "")}/v1/models`, {
        headers: { "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
    } catch {
      throw new Error(T.providerModelsUnreachable);
    }
    if (response.status === 401 || response.status === 403) throw new Error(T.providerModelsRejected);
    if (!response.ok) throw new Error(T.providerModelsUnlisted);
    const body = (await response.json().catch(() => null)) as { data?: { id?: unknown; display_name?: unknown; name?: unknown }[] } | null;
    const models = (body?.data ?? [])
      .map((m) => ({ id: typeof m.id === "string" ? m.id : "", name: typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : null }))
      .filter((m) => m.id)
      .slice(0, PROVIDER_LIMITS.models);
    if (!models.length) throw new Error(T.providerModelsUnlisted);
    return models;
  }

  private write() {
    writeFileAtomic(FILE, JSON.stringify({ providers: this.providers }, null, 2));
  }

  private async publish() {
    const views = await this.views();
    this.onChange(views);
    return views;
  }
}

export function providerEnv(provider: CustomProvider, key: string, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}
