import { useEffect, useMemo, useRef, useState } from "react";
import type { VscodeCandidate, VscodeImportList, VscodeImportResult } from "../shared/protocol";
import { Refresh } from "./icons";
import { displayPath } from "./displayPath";
import { rpc } from "./rpc";
import { relativeTime } from "./sessionList";
import { openAgent, setState } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { announce } from "./announce";

export function ImportSettings({ scroll }: { scroll: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { list, error, loading, reload } = useCandidates();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ text: string; failures: VscodeImportResult[] } | null>(null);

  // 목록이 들어온 뒤에야 묶음이 길어져서 맨 위까지 스크롤할 수 있다
  const loaded = list !== null;
  useEffect(() => {
    if (scroll) ref.current?.scrollIntoView({ block: "start" });
  }, [scroll, loaded]);

  const candidates = list?.candidates ?? [];
  const visible = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return candidates;
    return candidates.filter((c) => words.every((w) => `${c.title} ${c.cwd ?? ""}`.toLowerCase().includes(w)));
  }, [candidates, filter]);
  const selectable = visible.filter((c) => !c.problem && !c.importedAgentId);
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.key));
  const running = progress !== null;

  const toggle = (key: string, on: boolean) => setSelected((prev) => new Set(on ? [...prev, key] : [...prev].filter((k) => k !== key)));
  const toggleAll = () => setSelected((prev) => (allSelected ? new Set([...prev].filter((k) => !selectable.some((c) => c.key === k))) : new Set([...prev, ...selectable.map((c) => c.key)])));

  const run = async () => {
    const keys = candidates.filter((c) => selected.has(c.key)).map((c) => c.key);
    if (!keys.length || running) return;
    setSummary(null);
    const results: VscodeImportResult[] = [];
    setProgress({ done: 0, total: keys.length });
    for (const key of keys) {
      try {
        results.push(...(await rpc.call("import.vscodeRun", { keys: [key] })));
      } catch (e) {
        results.push({ key, agentId: null, outcome: "failed", items: 0, added: 0, note: (e as Error).message });
      }
      setProgress({ done: results.length, total: keys.length });
    }
    const count = (outcome: VscodeImportResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
    const text = S.importSummary({ created: count("created"), updated: count("updated"), unchanged: count("unchanged"), skipped: count("skipped"), failed: count("failed") });
    setProgress(null);
    setSelected(new Set());
    setSummary({ text, failures: results.filter((r) => r.outcome === "failed" || r.outcome === "skipped") });
    // 같은 요약이 가져오기 구역 안에 이미 그려지므로 낭독만 한다
    announce(text);
    reload();
  };

  return (
    <div className="status-section" ref={ref} data-testid="import-section">
      <div className="status-row small import-toolbar" data-wide>
        <input className="input grow" aria-label={S.importFilter} placeholder={S.importFilter} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="icon" aria-label={S.importRefresh} title={S.importRefresh} disabled={loading || running} onClick={reload}>
          <span className={loading ? "spin" : "import-icon"}>
            <Refresh size={14} />
          </span>
        </Button>
        <Button size="sm" disabled={running || selectable.length === 0} onClick={toggleAll}>
          {allSelected ? S.importClear : S.importSelectAll}
        </Button>
        <Button size="sm" variant="primary" disabled={running || selected.size === 0} onClick={() => void run()}>
          {S.importRun(selected.size)}
        </Button>
      </div>
      {list?.available && (
        <div className="status-row muted small import-counts" data-wide>
          {S.importCounts(list.stats.importable, list.stats.alreadyImported)}
        </div>
      )}
      {progress && (
        <div className="import-progress" data-testid="import-progress">
          <div className="import-progress-text small">{S.importProgress(progress.done, progress.total)}</div>
          <div className="import-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="import-progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      {summary && (
        <div className="import-summary small" data-testid="import-summary">
          <div>{summary.text}</div>
          {summary.failures.length > 0 && <div className="muted">{S.importResultFailures(summary.failures.length)}</div>}
          {summary.failures.map((r) => (
            <div key={r.key} className="muted import-failure">
              {titleOfKey(candidates, r.key)}: {r.note}
            </div>
          ))}
        </div>
      )}
      {loading && !list && <div className="status-row muted small">{S.importLoading}</div>}
      {error && <div className="status-row error-text small">{S.importUnavailable(error)}</div>}
      {list && !list.available && (isMissingState(list.reason) ? <div className="status-row muted small">{S.importNone}</div> : <div className="status-row error-text small">{S.importUnavailable(list.reason ?? "")}</div>)}
      {list?.available && (
        <ul className="import-list" aria-label={S.importListAria}>
          {visible.map((c) => (
            <ImportRow key={c.key} candidate={c} indented={c.parentKey !== null && visible.some((p) => p.key === c.parentKey)} checked={selected.has(c.key)} disabled={running} onToggle={(on) => toggle(c.key, on)} />
          ))}
          {visible.length === 0 && <li className="import-empty muted small">{candidates.length ? S.importNoMatch : S.importEmpty}</li>}
        </ul>
      )}
    </div>
  );
}

function useCandidates() {
  const [list, setList] = useState<VscodeImportList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc
      .call("import.vscodeList", {})
      .then((value) => {
        if (cancelled) return;
        setList(value);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [version]);
  return { list, error, loading, reload: () => setVersion((v) => v + 1) };
}

function ImportRow({ candidate: c, indented, checked, disabled, onToggle }: { candidate: VscodeCandidate; indented: boolean; checked: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const blocked = c.problem !== null;
  const id = `import-${c.key}`;
  const detail = [c.cwd ? displayPath(c.cwd) : null, c.updatedAt ? relativeTime(c.updatedAt, Date.now()) : null].filter(Boolean).join("  ");
  return (
    <li className="import-row" data-indented={indented || undefined} data-blocked={blocked || undefined} data-testid="import-row">
      <Checkbox id={id} aria-label={S.importSelectAria(c.title)} checked={checked} disabled={disabled || blocked} onCheckedChange={(v) => onToggle(v === true)} />
      <label htmlFor={id} className="import-text">
        <span className="import-title">{c.title}</span>
        <span className="import-detail">{detail}</span>
      </label>
      <span className="import-chips">
        <ImportChips candidate={c} />
        {c.importedAgentId && (
          <Button size="sm" onClick={() => openImported(c.importedAgentId as string)}>
            {S.importOpen}
          </Button>
        )}
      </span>
    </li>
  );
}

function ImportChips({ candidate: c }: { candidate: VscodeCandidate }) {
  return (
    <>
      {c.importedAgentId && <span className="import-chip" data-tone="ok">{S.importChipImported}</span>}
      {c.kind === "peer" && <span className="import-chip">{c.origin === "sideChat" ? S.importChipSideChat : S.importChipChat}</span>}
      {c.kind === "main" && c.chats > 1 && (
        <span className="import-chip" title={S.importChipChatsTip(c.chats, c.subagentChats)}>
          {S.importChipChats(c.chats)}
        </span>
      )}
      {c.archived && <span className="import-chip">{S.importChipArchived}</span>}
      {c.running && (
        <span className="import-chip" data-tone="warn" title={S.importChipRunningTip}>
          {S.importChipRunning}
        </span>
      )}
      {c.claudeSessionId !== null && c.hasJsonl && !c.cwdExists && (
        <span className="import-chip" data-tone="warn" title={S.importChipFolderMissingTip}>
          {S.importChipFolderMissing}
        </span>
      )}
      {c.problem === "noTranscript" && (
        <span className="import-chip" data-tone="warn" title={S.importChipNoHistoryTip}>
          {S.importChipNoHistory}
        </span>
      )}
      {c.problem === "noSessionId" && (
        <span className="import-chip" data-tone="warn" title={S.importChipNoSessionTip}>
          {S.importChipNoSession}
        </span>
      )}
    </>
  );
}

function openImported(agentId: string) {
  setState({ overlay: null });
  openAgent(agentId);
}

const titleOfKey = (candidates: VscodeCandidate[], key: string) => candidates.find((c) => c.key === key)?.title ?? key;

function isMissingState(reason: string | null | undefined) {
  return (reason ?? "").startsWith("VS Code state file not found");
}
