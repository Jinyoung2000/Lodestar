import { useEffect, useMemo, useState } from "react";
import { KEYMAP_PRESETS, type CommandKeys, type KeymapPreset } from "../shared/protocol";
import { titleOf } from "./commands";
import { Codicon } from "./icons";
import { assignKeys, bindingsFor, CHORD_TIMEOUT_MS, findConflicts, isRecordableStroke, presetBindings, resetKeys, strokeOf, whenOf } from "./keymap";
import { canRestartDaemon } from "./reload";
import { rpc } from "./rpc";
import { Palette } from "./Palette";
import { filterShortcuts, groupByCategory, shortcutRows, strokeLabel, type ShortcutRow } from "./shortcutList";
import { claimKeys } from "./shortcuts";
import { hiddenCommands } from "./screenVisibility";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Recording = { command: string; strokes: string[] };
type Conflict = { command: string; sequence: string; others: string[] };

export function ShortcutsView() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const settings = useStore((s) => s.settings);
  const preset = settings?.keymapPreset ?? "vscode";
  const overrides = settings?.keymapOverrides?.[preset];
  const bindings = bindingsFor(preset, overrides);
  const rows = useMemo(() => shortcutRows(bindings, { desktop: canRestartDaemon(), hidden: hiddenCommands(settings), changed: new Set(Object.keys(overrides ?? {})) }), [settings, bindings, overrides]);
  const results = useMemo(() => filterShortcuts(rows, query), [rows, query]);
  const groups = useMemo(() => groupByCategory(results), [results]);
  const active = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    document.querySelector(".shortcuts-list [data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const save = (next: CommandKeys) => {
    const all = { ...settings?.keymapOverrides };
    if (Object.keys(next).length) all[preset] = next;
    else delete all[preset];
    void rpc.call("settings.set", { keymapOverrides: all });
  };
  const commit = (command: string, sequence: string) => {
    setRecording(null);
    const others = findConflicts(bindings, command, sequence, whenOf(presetBindings(preset), command), presetBindings(preset));
    if (others.length) setConflict({ command, sequence, others });
    else save(assignKeys(presetBindings(preset), overrides, command, sequence));
  };
  useKeyRecorder(recording, setRecording, commit);

  return (
    <Palette
      quickpick
      count={S.shortcutCount(results.length)}
      label={S.shortcutsTitle}
      title={S.shortcutsTitle}
      placeholder={S.shortcutsPlaceholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, results.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
      }}
      footer={null}
    >
      <div className="shortcuts-list">
        <div className="shortcuts-preset">
          <span className="shortcuts-preset-label">{S.keymapPreset}</span>
          <Select value={preset} onValueChange={(value) => void rpc.call("settings.set", { keymapPreset: value as KeymapPreset })}>
            <SelectTrigger boxed aria-label={S.keymapPreset} title={S.keymapPresetHint}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEYMAP_PRESETS.map((value) => (
                <SelectItem key={value} value={value}>
                  {S.keymapPresets[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {groups.map((group) => (
          <section key={group.category} aria-label={group.category}>
            <h3 className="shortcuts-category">{group.category}</h3>
            {group.rows.map((row) => (
              <ShortcutLine
                key={row.command}
                row={row}
                active={results[active] === row}
                recording={recording?.command === row.command ? recording : null}
                conflict={conflict?.command === row.command ? conflict : null}
                onHover={() => setIndex(results.indexOf(row))}
                onEdit={() => {
                  setConflict(null);
                  setRecording({ command: row.command, strokes: [] });
                }}
                onReset={() => save(resetKeys(overrides, row.command))}
                onCancel={() => setConflict(null)}
                onReassign={() => {
                  if (!conflict) return;
                  setConflict(null);
                  save(assignKeys(presetBindings(preset), overrides, conflict.command, conflict.sequence, conflict.others));
                }}
              />
            ))}
          </section>
        ))}
        {results.length === 0 && <div className="quickpick-empty">{S.noShortcuts}</div>}
      </div>
    </Palette>
  );
}

function useKeyRecorder(recording: Recording | null, update: (next: Recording | null) => void, done: (command: string, sequence: string) => void) {
  useEffect(() => {
    if (!recording) return;
    const take = (stroke: string) => {
      if (stroke === "Escape") return update(null);
      const first = recording.strokes.length === 0;
      if (!isRecordableStroke(stroke, first)) return;
      if (first) update({ ...recording, strokes: [stroke] });
      else done(recording.command, `${recording.strokes[0]} ${stroke}`);
    };
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "keydown" || event.isComposing) return;
      const stroke = strokeOf(event);
      if (stroke) take(stroke);
    };
    const release = claimKeys((stroke) => {
      take(stroke);
      return true;
    });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    const timer = recording.strokes.length === 1 ? setTimeout(() => done(recording.command, recording.strokes[0]), CHORD_TIMEOUT_MS) : undefined;
    return () => {
      release();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      clearTimeout(timer);
    };
  }, [recording]);
}

type ShortcutLineProps = {
  row: ShortcutRow;
  active: boolean;
  recording: Recording | null;
  conflict: Conflict | null;
  onHover: () => void;
  onEdit: () => void;
  onReset: () => void;
  onCancel: () => void;
  onReassign: () => void;
};

function ShortcutLine({ row, active, recording, conflict, onHover, onEdit, onReset, onCancel, onReassign }: ShortcutLineProps) {
  const name = row.title.replace(/^[^:]+: /, "");
  const pending = recording?.strokes.length ? recording.strokes : conflict ? conflict.sequence.split(" ") : null;
  return (
    <>
      <div className="quickpick-row shortcuts-row" data-shortcut={row.command} data-active={active || undefined} data-changed={row.changed || undefined} onMouseMove={onHover}>
        <span className="quickpick-title">{name}</span>
        {row.when && <span className="quickpick-section">{row.when}</span>}
        <span className="shortcuts-keys">
          {recording || conflict ? (
            <span className="shortcuts-recording" role="status">
              {pending ? pending.map(strokeLabel).join(" ") : S.shortcutRecording}
            </span>
          ) : (
            row.keys.map((steps, n) => (
              <span key={n} className="keycaps" aria-label={steps.join(" then ")}>
                {steps.map((step, m) => (
                  <kbd key={m} className="keycap">
                    {step}
                  </kbd>
                ))}
              </span>
            ))
          )}
        </span>
        <span className="shortcuts-actions">
          {row.changed && !recording && !conflict ? (
            <button type="button" className="shortcuts-action" aria-label={S.shortcutReset(name)} title={S.shortcutReset(name)} onClick={onReset}>
              <Codicon name="discard" size={14} />
            </button>
          ) : (
            <span className="shortcuts-action" aria-hidden="true" />
          )}
          {!recording && !conflict ? (
            <button type="button" className="shortcuts-action shortcuts-edit" aria-label={S.shortcutChange(name)} title={S.shortcutChange(name)} onClick={onEdit}>
              <Codicon name="edit" size={14} />
            </button>
          ) : (
            <span className="shortcuts-action" aria-hidden="true" />
          )}
        </span>
      </div>
      {conflict && (
        <div className="shortcuts-conflict" role="alert">
          <span className="shortcuts-conflict-text">
            <Codicon name="warning" size={14} />
            <span>{S.shortcutConflict(conflict.sequence.split(" ").map(strokeLabel).join(" "), titleOf(conflict.others[0]) ?? conflict.others[0])}</span>
          </span>
          <Button size="sm" onClick={onCancel}>
            {S.shortcutCancel}
          </Button>
          <Button size="sm" variant="secondary" onClick={onReassign}>
            {S.shortcutReassign}
          </Button>
        </div>
      )}
    </>
  );
}
