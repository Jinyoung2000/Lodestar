import { useEffect, useMemo, useState } from "react";
import { KEYMAP_PRESETS, type KeymapPreset } from "../shared/protocol";
import { bindingsFor } from "./keymap";
import { canRestartDaemon } from "./reload";
import { rpc } from "./rpc";
import { Palette } from "./Palette";
import { filterShortcuts, groupByCategory, shortcutRows } from "./shortcutList";
import { hiddenCommands } from "./screenVisibility";
import { useStore } from "./store";
import { S } from "./strings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// FIX6C: 키보드 단축키 목록(⌘K ⌘S, 명령 팔레트의 Preferences: Open Keyboard Shortcuts). 단축키 표에서 만든 목록이라 실제 키와 어긋나지 않는다.
export function ShortcutsView() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const settings = useStore((s) => s.settings);
  const preset = settings?.keymapPreset ?? "vscode";
  const rows = useMemo(() => shortcutRows(bindingsFor(preset), { desktop: canRestartDaemon(), hidden: hiddenCommands(settings) }), [settings, preset]);
  const results = useMemo(() => filterShortcuts(rows, query), [rows, query]);
  const groups = useMemo(() => groupByCategory(results), [results]);
  const active = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    document.querySelector(".shortcuts-list [data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

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
              <div key={row.command} className="quickpick-row shortcuts-row" data-shortcut={row.command} data-active={results[active] === row || undefined} onMouseMove={() => setIndex(results.indexOf(row))}>
                <span className="quickpick-title">{row.title.replace(/^[^:]+: /, "")}</span>
                {row.when && <span className="quickpick-section">{row.when}</span>}
                <span className="shortcuts-keys">
                  {row.keys.map((steps, n) => (
                    <span key={n} className="keycaps" aria-label={steps.join(" then ")}>
                      {steps.map((step, m) => (
                        <kbd key={m} className="keycap">
                          {step}
                        </kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        {results.length === 0 && <div className="quickpick-empty">{S.noShortcuts}</div>}
      </div>
    </Palette>
  );
}
