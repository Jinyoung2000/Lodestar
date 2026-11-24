import { useState } from "react";
import { PROVIDER_PRESETS, providerHost, type CustomProviderView, type ProviderModel } from "../shared/customProviders";
import { confirmAction } from "./ConfirmDialog";
import { Close, CustomProviderIcon } from "./icons";
import { rpc } from "./rpc";
import { setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type ModelRow = { key: number; id: string; name: string };
type KeyState = "saved" | "replace" | "remove";
type Draft = { id: string | null; preset: string | null; name: string; baseUrl: string; key: string; keyState: KeyState; models: ModelRow[]; defaultKey: number | null };

const CUSTOM_PRESET = "custom";
let nextRowKey = 1;
const modelRow = (id = "", name = ""): ModelRow => ({ key: nextRowKey++, id, name });

function draftOf(provider: CustomProviderView | null): Draft {
  if (!provider) {
    const row = modelRow();
    return { id: null, preset: null, name: "", baseUrl: "", key: "", keyState: "replace", models: [row], defaultKey: row.key };
  }
  const rows = provider.models.map((m) => modelRow(m.id, m.name ?? ""));
  return {
    id: provider.id,
    preset: provider.preset,
    name: provider.name,
    baseUrl: provider.baseUrl,
    key: "",
    keyState: provider.hasKey ? "saved" : "replace",
    models: rows,
    defaultKey: rows.find((r) => r.id === provider.defaultModel)?.key ?? rows[0]?.key ?? null,
  };
}

export function ProvidersSettings() {
  const providers = useStore((s) => s.customProviders);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = providers ?? [];
  return (
    <div className="setting-mobile provider-settings">
      <div className="setting-mobile-devices">
        {list.length === 0 && editing !== "new" && <div className="setting-empty">{S.providersEmpty}</div>}
        {list.map((provider) =>
          editing === provider.id ? (
            <ProviderForm key={provider.id} provider={provider} onDone={() => setEditing(null)} />
          ) : (
            <ProviderRow key={provider.id} provider={provider} onEdit={() => setEditing(provider.id)} />
          ),
        )}
        {editing === "new" && <ProviderForm provider={null} onDone={() => setEditing(null)} />}
      </div>
      {editing !== "new" && list.length < 20 && (
        <div>
          <Button variant="secondary" size="default" onClick={() => setEditing("new")}>
            {S.providerAdd}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProviderRow({ provider, onEdit }: { provider: CustomProviderView; onEdit: () => void }) {
  return (
    <div className="setting-subrow link-row provider-row">
      <CustomProviderIcon name={provider.name} size={14} />
      <div className="link-row-text">
        <span className="link-row-name">{provider.name}</span>
        <span className="link-row-detail">
          <span className="mono">{providerHost(provider.baseUrl)}</span>
          {" · "}
          {S.providerModelCount(provider.models.length)}
          {" · "}
          <span className={provider.hasKey ? undefined : "setting-warning"}>{provider.hasKey ? S.providerKeySaved : S.providerNoKey}</span>
        </span>
      </div>
      <Button size="sm" onClick={onEdit}>
        {S.providerEdit}
      </Button>
    </div>
  );
}

function ProviderForm({ provider, onDone }: { provider: CustomProviderView | null; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(provider));
  const [problem, setProblem] = useState<string | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "load" | "delete" | null>(null);
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const setRow = (key: number, next: Partial<ModelRow>) => setDraft((d) => ({ ...d, models: d.models.map((r) => (r.key === key ? { ...r, ...next } : r)) }));
  const removeRow = (key: number) => setDraft((d) => {
    const models = d.models.filter((r) => r.key !== key);
    return { ...d, models, defaultKey: d.defaultKey === key ? (models[0]?.key ?? null) : d.defaultKey };
  });
  const addRow = () => setDraft((d) => {
    const row = modelRow();
    return { ...d, models: [...d.models, row], defaultKey: d.defaultKey ?? row.key };
  });
  const choosePreset = (value: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === value);
    patch(preset ? { preset: preset.id, name: preset.name, baseUrl: preset.baseUrl } : { preset: null });
  };
  const typedKey = draft.keyState === "replace" ? draft.key.trim() : "";
  const canLoad = !!draft.baseUrl.trim() && (typedKey.length > 0 || draft.keyState === "saved");

  const loadModels = () => {
    if (!canLoad || busy) return;
    setBusy("load");
    setModelsNote(null);
    void rpc
      .call("providers.loadModels", { id: draft.keyState === "saved" ? draft.id : null, baseUrl: draft.baseUrl, key: typedKey || null })
      .then((models: ProviderModel[]) => {
        const rows = models.map((m) => modelRow(m.id, m.name ?? ""));
        setDraft((d) => {
          const kept = d.models.filter((r) => r.id.trim() && !models.some((m) => m.id === r.id.trim()));
          const merged = [...kept, ...rows];
          const current = d.models.find((r) => r.key === d.defaultKey)?.id;
          return { ...d, models: merged, defaultKey: merged.find((r) => r.id === current)?.key ?? merged[0]?.key ?? null };
        });
      })
      .catch((error: Error) => setModelsNote(error.message))
      .finally(() => setBusy(null));
  };

  const save = () => {
    if (busy) return;
    const models = draft.models.filter((r) => r.id.trim()).map((r) => ({ id: r.id.trim(), name: r.name.trim() || null }));
    const defaultModel = draft.models.find((r) => r.key === draft.defaultKey)?.id.trim() || (models[0]?.id ?? null);
    const key = draft.keyState === "remove" ? null : typedKey || undefined;
    setBusy("save");
    setProblem(null);
    void rpc
      .call("providers.save", { provider: { id: draft.id, name: draft.name, baseUrl: draft.baseUrl, models, defaultModel, preset: draft.preset }, ...(key === undefined ? {} : { key }) })
      .then((customProviders) => {
        setState({ customProviders });
        onDone();
      })
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setBusy(null));
  };

  const remove = async () => {
    if (!provider || busy) return;
    if (!(await confirmAction(S.providerDeleteTitle(provider.name), S.providerDelete, S.providerDeleteDetail, "warning"))) return;
    setBusy("delete");
    void rpc
      .call("providers.delete", { id: provider.id })
      .then((customProviders) => {
        setState({ customProviders });
        onDone();
      })
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setBusy(null));
  };

  return (
    <form
      className="provider-form"
      aria-label={provider ? S.providerEditAria(provider.name) : S.providerNew}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {provider ? (
        <div className="provider-form-title">
          <CustomProviderIcon name={draft.name || provider.name} size={14} />
          <span className="link-row-name">{provider.name}</span>
        </div>
      ) : (
        <div className="setting-mobile-heading">{S.providerNew}</div>
      )}
      {!provider && (
        <div className="provider-field">
          <span className="provider-label">{S.providerPreset}</span>
          <Select value={draft.preset ?? CUSTOM_PRESET} onValueChange={choosePreset}>
            <SelectTrigger boxed aria-label={S.providerPreset}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_PRESET}>{S.providerPresetCustom}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <label className="provider-field">
        <span className="provider-label">{S.providerName}</span>
        <input className="input setting-text-input" spellCheck={false} maxLength={40} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label className="provider-field">
        <span className="provider-label">{S.providerBaseUrl}</span>
        <input className="input setting-text-input mono" spellCheck={false} placeholder="https://" value={draft.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
      </label>
      <div className="provider-field provider-field-top">
        <span className="provider-label">{S.providerApiKey}</span>
        {draft.keyState === "saved" ? (
          <div className="provider-key-line">
            <span className="provider-key-saved">{S.providerKeySavedShort}</span>
            <Button size="sm" type="button" onClick={() => patch({ keyState: "replace", key: "" })}>
              {S.providerKeyReplace}
            </Button>
            <Button size="sm" type="button" onClick={() => patch({ keyState: "remove", key: "" })}>
              {S.providerKeyRemove}
            </Button>
          </div>
        ) : draft.keyState === "remove" ? (
          <div className="provider-key-line">
            <span className="setting-warning">{S.providerKeyRemovedOnSave}</span>
            <Button size="sm" type="button" onClick={() => patch({ keyState: "saved" })}>
              {S.providerKeyUndo}
            </Button>
          </div>
        ) : (
          <div className="provider-key-input">
            <input className="input setting-text-input mono" type="password" autoComplete="off" spellCheck={false} aria-label={S.providerApiKey} value={draft.key} onChange={(e) => patch({ key: e.target.value })} />
            <span className="provider-hint">{S.providerKeyHint}</span>
          </div>
        )}
      </div>
      <div className="provider-field provider-field-top">
        <span className="provider-label">{S.providerModels}</span>
        <div className="provider-models">
          <div className="provider-model-head" aria-hidden="true">
            <span>{S.providerModelDefault}</span>
            <span>{S.providerModelId}</span>
            <span>{S.providerModelName}</span>
            <span />
          </div>
          {draft.models.map((row) => (
            <div key={row.key} className="provider-model-row">
              <input type="radio" name={`provider-default-${draft.id ?? "new"}`} aria-label={S.providerModelDefaultAria(row.id || S.providerModelId)} checked={draft.defaultKey === row.key} onChange={() => patch({ defaultKey: row.key })} />
              <input className="input mono" spellCheck={false} aria-label={S.providerModelId} value={row.id} onChange={(e) => setRow(row.key, { id: e.target.value })} />
              <input className="input" spellCheck={false} aria-label={S.providerModelName} placeholder={S.providerModelNamePlaceholder} value={row.name} onChange={(e) => setRow(row.key, { name: e.target.value })} />
              <button type="button" className="icon-button" aria-label={S.providerModelRemove(row.id || S.providerModelId)} title={S.providerModelRemove(row.id || S.providerModelId)} onClick={() => removeRow(row.key)}>
                <Close size={14} />
              </button>
            </div>
          ))}
          <div className="provider-models-actions">
            <Button size="sm" type="button" disabled={!canLoad || busy !== null} onClick={loadModels}>
              {busy === "load" ? S.providerLoadingModels : S.providerLoadModels}
            </Button>
            <Button size="sm" type="button" onClick={addRow}>
              {S.providerAddModel}
            </Button>
            {!canLoad && <span className="provider-hint">{S.providerLoadNeedsKey}</span>}
          </div>
          {modelsNote && <div className="setting-warning">{modelsNote}</div>}
        </div>
      </div>
      {problem && <div className="setting-problem provider-problem" role="alert">{problem}</div>}
      <div className="provider-form-foot">
        {provider && (
          <Button size="sm" type="button" disabled={busy !== null} onClick={() => void remove()}>
            {S.providerDelete}
          </Button>
        )}
        <span className="spacer" />
        <Button size="sm" type="button" onClick={onDone}>
          {S.cancel}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy !== null}>
          {busy === "save" ? S.providerSaving : S.providerSave}
        </Button>
      </div>
    </form>
  );
}
