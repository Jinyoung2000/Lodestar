import { useEffect, useMemo, useRef, useState } from "react";
import { activeAgentOf } from "./activeAgentOf";
import { BrowserHistory, DevicePresets, SitePermissions, UserAgentPrompt } from "./BrowserOverlays";
import { filterCommands, paletteCommands, type PaletteCommand } from "./commands";
import { GlobalSearch } from "./GlobalSearch";
import { GoToLine } from "./GoToLine";
import { GoToSymbol } from "./GoToSymbol";
import { bindingsFor } from "./keymap";
import { EditorPickOverlay } from "./EditorPick";
import { linkActions } from "../shared/linkIntent";
import { linkRows, needsSimulator, type LinkRow, type SimulatorState } from "./linkRows";
import { revealLocation, searchWorkspaceSymbols, type SymbolInfo } from "./lsp";
import { CustomizeLayout } from "./CustomizeLayout";
import { Palette } from "./Palette";
import { QuickOpen } from "./QuickOpen";
import { ChoiceOverlay, DevicePicker } from "./QuickChoice";
import { ShortcutsView } from "./ShortcutsView";
import { canRestartDaemon } from "./reload";
import { rpc } from "./rpc";
import { runCommand } from "./shortcuts";
import { hiddenCommands } from "./screenVisibility";
import { openBrowser, setState, useStore } from "./store";
import { S } from "./strings";

export function Overlays() {
  const overlay = useStore((s) => s.overlay);
  return (
    <>
      {overlay?.kind === "quickOpen" && <QuickOpen />}
      {overlay?.kind === "symbols" && <SymbolSearch initialQuery={overlay.query ?? ""} />}
      {(overlay?.kind === "search" || overlay?.kind === "sessions") && <GlobalSearch key={overlay.kind} initialTab={overlay.kind === "sessions" ? "sessions" : (overlay.tab ?? "all")} />}
      {overlay?.kind === "shortcuts" && <ShortcutsView />}
      {overlay?.kind === "commands" && <CommandPalette initialQuery={overlay.query ?? ">"} />}
      {overlay?.kind === "browserHistory" && <BrowserHistory tabKey={overlay.tabKey} />}
      {overlay?.kind === "sitePermissions" && <SitePermissions url={overlay.url} />}
      {overlay?.kind === "devicePresets" && <DevicePresets tabKey={overlay.tabKey} />}
      {overlay?.kind === "userAgent" && <UserAgentPrompt tabKey={overlay.tabKey} value={overlay.value} />}
      {overlay?.kind === "device" && <DevicePicker key={overlay.request.requestId} request={overlay.request} />}
      {overlay?.kind === "choice" && <ChoiceOverlay key={overlay.id} id={overlay.id} />}
      {overlay?.kind === "gotoLine" && <GoToLine tabKey={overlay.tabKey} />}
      {overlay?.kind === "gotoSymbol" && <GoToSymbol tabKey={overlay.tabKey} initialQuery={overlay.query} />}
      {overlay?.kind === "editorPick" && <EditorPickOverlay key={overlay.id} id={overlay.id} />}
      {overlay?.kind === "customizeLayout" && <CustomizeLayout />}
    </>
  );
}

function CommandPalette({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const settings = useStore((s) => s.settings);
  const operator = useStore((s) => s.operator);
  const all = useMemo(() => {
    const preset = settings?.keymapPreset ?? "vscode";
    const overrides = settings?.keymapOverrides?.[preset];
    const unbound = Object.entries(overrides ?? {}).flatMap(([command, keys]) => (keys.length ? [] : [command]));
    return paletteCommands(bindingsFor(preset, overrides), { desktop: canRestartDaemon(), hidden: hiddenCommands(settings, operator), unbound });
  }, [settings, operator]);
  const results = useMemo(() => filterCommands(all, query), [all, query]);
  const active = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    document.querySelector(".palette-quickpick [data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteCommand | undefined) => {
    if (!item) return;
    setState({ overlay: null });
    setTimeout(() => runCommand(item.command), 0);
  };

  return (
    <Palette
      quickpick
      label={S.commandPalette}
      placeholder={S.commandPlaceholder}
      query={query}
      onQuery={(value) => {
        if (!value.startsWith(">")) {
          setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: value });
          return;
        }
        setQuery(value);
        setIndex(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, results.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing) choose(results[active]);
      }}
      footer={null}
    >
      {results.map((item, i) => (
        <button key={item.command} type="button" className="quickpick-row" data-command={item.command} data-active={i === active || undefined} onClick={() => choose(item)}>
          <span className="quickpick-title">{item.title}</span>
          <span className="keycaps">
            {item.keycaps.map((cap, n) => (
              <kbd key={n} className="keycap">
                {cap}
              </kbd>
            ))}
          </span>
        </button>
      ))}
      {results.length === 0 && <div className="quickpick-empty">{S.noCommands}</div>}
    </Palette>
  );
}

const SYMBOL_KIND: Record<number, string> = {
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  22: "enum member",
  26: "type",
};

function SymbolSearch({ initialQuery }: { initialQuery: string }) {
  const workspaceId = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents)?.workspaceId ?? s.activeWorkspaceId);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!workspaceId || !query.trim()) {
      setResults([]);
      return;
    }
    const id = ++requestId.current;
    setStatus(S.searching);
    const timer = setTimeout(() => {
      searchWorkspaceSymbols(workspaceId, query.trim())
        .then((symbols) => {
          if (id !== requestId.current) return;
          setResults(symbols.slice(0, 50));
          setIndex(0);
          setStatus(symbols.length ? null : S.noResults);
        })
        .catch((e: Error) => {
          if (id === requestId.current) setStatus(S.searchFailed(e.message));
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [workspaceId, query]);

  const actions = useMemo(() => linkActions(query), [query]);
  const simulator = useBootedSimulators(needsSimulator(actions));
  const linkRowList = useMemo(() => linkRows(actions, simulator), [actions, simulator]);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launching = useRef(false);
  const rowCount = linkRowList.length + results.length;

  const choose = (symbol: SymbolInfo | undefined) => {
    if (!symbol || !workspaceId) return;
    setState({ overlay: null });
    revealLocation(workspaceId, symbol.location);
  };

  const runLink = (row: LinkRow | undefined) => {
    if (!row?.run || launching.current) return;
    if (row.run.kind === "browser") {
      setState({ overlay: null });
      openBrowser(row.run.url);
      return;
    }
    launching.current = true;
    rpc
      .call("simulator.openUrl", { url: row.run.url, udid: row.run.udid })
      .then(() => setState({ overlay: null }))
      .catch((e: Error) => setLaunchError(S.linkSimulatorOpenFailed(e.message)))
      .finally(() => {
        launching.current = false;
      });
  };

  return (
    <Palette
      label={S.searchSymbols}
      placeholder={S.symbolPlaceholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(0);
        setLaunchError(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, Math.max(rowCount - 1, 0)));
        if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          if (index < linkRowList.length) runLink(linkRowList[index]);
          else choose(results[index - linkRowList.length]);
        }
      }}
      footer={launchError ?? (linkRowList.length > 0 && results.length === 0 ? null : status)}
    >
      {linkRowList.map((row, i) => (
        <LinkRowButton key={row.key} row={row} active={i === index} onRun={() => runLink(row)} />
      ))}
      {results.map((symbol, i) => (
        <button
          key={`${symbol.location.uri}:${symbol.location.range.start.line}:${symbol.name}`}
          type="button"
          className="palette-option palette-symbol"
          data-active={i + linkRowList.length === index || undefined}
          onClick={() => choose(symbol)}
        >
          <span className="kind-badge">{SYMBOL_KIND[symbol.kind] ?? "symbol"}</span>
          <span className="mono">{symbol.name}</span>
          <span className="mono muted small">{decodeURIComponent(symbol.location.uri.slice(symbol.location.uri.lastIndexOf("/") + 1))}</span>
        </button>
      ))}
    </Palette>
  );
}

function LinkRowButton({ row, active, onRun }: { row: LinkRow; active: boolean; onRun: () => void }) {
  return (
    <button type="button" className="palette-option palette-symbol palette-link" data-link-row={row.key} data-active={active || undefined} aria-disabled={row.run ? undefined : true} onClick={onRun}>
      <span className="kind-badge">link</span>
      <span>{row.title}</span>
      <span className="mono muted small">{row.detail}</span>
    </button>
  );
}

function useBootedSimulators(enabled: boolean): SimulatorState | null {
  const [booted, setBooted] = useState<SimulatorState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setBooted({ status: "loading" });
    rpc.call("simulator.devices", {}).then(
      (devices) => current && setBooted({ status: "ready", devices }),
      (e: Error) => current && setBooted({ status: "error", message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled ? booted : null;
}
