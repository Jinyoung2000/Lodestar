import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { PERMISSION_MODE_VALUES, type EffortLevel, type PermissionMode } from "../shared/protocol";
import { saveAutomation } from "./automationActions";
import { DAY_NAMES, DAY_ORDER, draftOf, inputOf, ONCE_FORMAT, type AutomationDraft } from "./automationModel";
import { supportedLevels } from "./effortLevels";
import { Codicon } from "./icons";
import { rpc } from "./rpc";
import { closeAutomationEditor, getState, isTopWorkspace, openAutomation, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import "./automations.css";

const A = S.automation;
const DEFAULT = "__default";

export function AutomationEditorHost() {
  const target = useStore((s) => s.automationEditor);
  const open = useStore((s) => s.automationEditorOpen);
  return (
    <DialogPrimitive.Root open={open && !!target} onOpenChange={(next) => !next && closeAutomationEditor()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="automation-dialog-overlay" />
        <DialogPrimitive.Content className="automation-dialog" aria-describedby={undefined}>
          {target && <EditorForm key={target.mode === "edit" ? target.id : "create"} editId={target.mode === "edit" ? target.id : null} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function initialDraft(editId: string | null): AutomationDraft {
  const s = getState();
  const automation = editId ? (s.automations?.automations.find((a) => a.id === editId) ?? null) : null;
  const tops = s.workspaces.filter((w) => isTopWorkspace(w) && !w.archived);
  const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  const workspaceId = (active && tops.find((w) => w.id === (active.parentId ?? active.id))?.id) ?? tops[0]?.id ?? "";
  return draftOf(automation, { workspaceId, permissionMode: s.defaults?.permissionMode.value ?? "default", now: new Date() });
}

function EditorForm({ editId }: { editId: string | null }) {
  const [draft, setDraft] = useState(() => initialDraft(editId));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (patch: Partial<AutomationDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblem(null);
  };
  const save = async () => {
    const result = inputOf(draft);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAutomation(editId, result.input);
      closeAutomationEditor();
      openAutomation(saved.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };
  return (
    <form
      className="automation-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="automation-dialog-head">
        <DialogPrimitive.Title className="automation-dialog-title">{editId ? A.editTitle : A.newTitle}</DialogPrimitive.Title>
        <DialogPrimitive.Close asChild>
          <Button size="icon" aria-label={A.close}>
            <Codicon name="close" size={14} />
          </Button>
        </DialogPrimitive.Close>
      </div>
      <div className="automation-dialog-body">
        <div>
          <label htmlFor="automation-title" className="automation-label">
            {A.title}
          </label>
          <input id="automation-title" className="input automation-input" value={draft.title} autoFocus onChange={(e) => change({ title: e.target.value })} />
        </div>
        <div>
          <label htmlFor="automation-prompt" className="automation-label">
            {A.prompt}
          </label>
          <textarea id="automation-prompt" className="automation-textarea" rows={5} value={draft.prompt} onChange={(e) => change({ prompt: e.target.value })} />
        </div>
        <ScheduleFields draft={draft} onChange={change} />
        <SessionFields draft={draft} onChange={change} />
        <ModelFields draft={draft} onChange={change} />
        {problem && (
          <div className="automation-problem" role="alert">
            {problem}
          </div>
        )}
      </div>
      <div className="automation-dialog-foot">
        <DialogPrimitive.Close asChild>
          <Button variant="secondary" size="default">
            {A.cancel}
          </Button>
        </DialogPrimitive.Close>
        <Button type="submit" variant="primary" size="default" disabled={saving}>
          {saving ? A.saving : A.save}
        </Button>
      </div>
    </form>
  );
}

type FieldsProps = { draft: AutomationDraft; onChange: (patch: Partial<AutomationDraft>) => void };

function Choice({ checked, label, onSelect, children }: { checked: boolean; label: string; onSelect: () => void; children?: ReactNode }) {
  return (
    <div className="automation-choice" data-checked={checked || undefined}>
      <button type="button" role="radio" aria-checked={checked} className="automation-radio" onClick={onSelect}>
        <span className="automation-radio-mark" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {children && <div className="automation-choice-fields">{children}</div>}
    </div>
  );
}

function ScheduleFields({ draft, onChange }: FieldsProps) {
  const toggleDay = (day: number) => onChange({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day] });
  return (
    <fieldset className="automation-fieldset">
      <legend className="automation-label">{A.schedule}</legend>
      <div className="automation-choices" role="radiogroup" aria-label={A.schedule}>
        <Choice checked={draft.kind === "interval"} label={A.interval} onSelect={() => onChange({ kind: "interval" })}>
          <label htmlFor="automation-interval" className="automation-hint">
            {A.every}
          </label>
          <input id="automation-interval" className="input automation-number" inputMode="numeric" value={draft.minutes} onFocus={() => onChange({ kind: "interval" })} onChange={(e) => onChange({ minutes: e.target.value })} />
          <span className="automation-hint">{A.minutes}</span>
        </Choice>
        <Choice checked={draft.kind === "daily"} label={A.daily} onSelect={() => onChange({ kind: "daily" })}>
          <label htmlFor="automation-time" className="automation-hint">
            {A.at}
          </label>
          <input id="automation-time" className="input automation-time" value={draft.time} onFocus={() => onChange({ kind: "daily" })} onChange={(e) => onChange({ time: e.target.value })} />
          <div className="automation-days" role="group" aria-label={A.days}>
            {DAY_ORDER.map((day) => (
              <button
                key={day}
                type="button"
                className="automation-day"
                aria-pressed={draft.weekdays.includes(day)}
                onClick={() => {
                  if (draft.kind !== "daily") onChange({ kind: "daily" });
                  toggleDay(day);
                }}
              >
                {DAY_NAMES[day]}
              </button>
            ))}
          </div>
        </Choice>
        <Choice checked={draft.kind === "once"} label={A.once} onSelect={() => onChange({ kind: "once" })}>
          <label htmlFor="automation-once" className="automation-hint">
            {A.on}
          </label>
          <input id="automation-once" className="input automation-picker" placeholder={ONCE_FORMAT} value={draft.onceAt} onFocus={() => onChange({ kind: "once" })} onChange={(e) => onChange({ onceAt: e.target.value })} />
        </Choice>
      </div>
    </fieldset>
  );
}

function SessionFields({ draft, onChange }: FieldsProps) {
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const [branches, setBranches] = useState<{ workspaceId: string; list: string[] } | null>(null);
  const folders = workspaces.filter((w) => isTopWorkspace(w) && !w.archived);
  const sessions = agents.filter((a) => !a.feedbackId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const branchList = branches?.workspaceId === draft.workspaceId ? branches.list : [];
  const loadBranches = (open: boolean) => {
    if (!open || !draft.workspaceId || branches?.workspaceId === draft.workspaceId) return;
    const workspaceId = draft.workspaceId;
    void rpc
      .call("git.branches", { workspaceId })
      .then((info) => setBranches({ workspaceId, list: info.locals.length ? info.locals : info.branches }))
      .catch(() => setBranches({ workspaceId, list: [] }));
  };
  const newSession = draft.targetKind === "newSession";
  return (
    <fieldset className="automation-fieldset">
      <legend className="automation-label">{A.session}</legend>
      <div className="automation-choices" role="radiogroup" aria-label={A.session}>
        <Choice checked={newSession} label={A.newSession} onSelect={() => onChange({ targetKind: "newSession" })}>
          <span className="automation-hint">{A.inFolder}</span>
          <Select value={draft.workspaceId || undefined} onValueChange={(workspaceId) => onChange({ workspaceId, targetKind: "newSession", base: "" })}>
            <SelectTrigger boxed className="automation-picker" aria-label={A.folder}>
              <Codicon name="folder" size={14} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {folders.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Choice>
        {newSession && (
          <div className="automation-worktree">
            <Switch checked={draft.worktree} aria-labelledby="automation-worktree-label" onCheckedChange={(worktree) => onChange({ worktree })} />
            <span id="automation-worktree-label">{A.newWorktree}</span>
            <span className="spacer" />
            {draft.worktree && (
              <>
                <span className="automation-hint">{A.baseBranch}</span>
                <Select value={draft.base || DEFAULT} onOpenChange={loadBranches} onValueChange={(base) => onChange({ base: base === DEFAULT ? "" : base })}>
                  <SelectTrigger boxed className="automation-branch" aria-label={A.baseBranch}>
                    <Codicon name="git-branch" size={14} />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}>{A.defaultBranch}</SelectItem>
                    {draft.base && !branchList.includes(draft.base) && <SelectItem value={draft.base}>{draft.base}</SelectItem>}
                    {branchList.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
        )}
        <Choice checked={!newSession} label={A.existingSession} onSelect={() => onChange({ targetKind: "session" })}>
          <Select value={draft.agentId || undefined} onValueChange={(agentId) => onChange({ agentId, targetKind: "session" })}>
            <SelectTrigger boxed className="automation-session-picker" aria-label={A.existingSession}>
              <SelectValue placeholder={A.pickSession} />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Choice>
      </div>
    </fieldset>
  );
}

function ModelFields({ draft, onChange }: FieldsProps) {
  const models = useStore((s) => s.meta?.models ?? []).filter((m) => m.value !== "default");
  const levels = supportedLevels(draft.model);
  const fixed = draft.targetKind === "session";
  return (
    <div className="automation-model-row" data-disabled={fixed || undefined}>
      <div className="automation-cell">
        <span id="automation-model-label" className="automation-label">
          {A.model}
        </span>
        <Select disabled={fixed} value={draft.model ?? DEFAULT} onValueChange={(value) => onChange({ model: value === DEFAULT ? null : value, effort: null })}>
          <SelectTrigger boxed className="automation-cell-trigger" aria-labelledby="automation-model-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{A.defaultModel}</SelectItem>
            {draft.model && !models.some((m) => m.value === draft.model) && <SelectItem value={draft.model}>{draft.model}</SelectItem>}
            {models.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="automation-cell">
        <span id="automation-effort-label" className="automation-label">
          {A.effort}
        </span>
        <Select disabled={fixed} value={draft.effort ?? DEFAULT} onValueChange={(value) => onChange({ effort: value === DEFAULT ? null : (value as EffortLevel) })}>
          <SelectTrigger boxed className="automation-cell-trigger" aria-labelledby="automation-effort-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{A.defaultEffort}</SelectItem>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                {S.effortNames[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="automation-cell">
        <span id="automation-permission-label" className="automation-label">
          {A.permission}
        </span>
        <Select disabled={fixed} value={draft.permissionMode} onValueChange={(value) => onChange({ permissionMode: value as PermissionMode })}>
          <SelectTrigger boxed className="automation-cell-trigger" aria-labelledby="automation-permission-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODE_VALUES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {S.permissionModes[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
