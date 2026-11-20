import { useEffect, useMemo, useState } from "react";
import { groupByDay, matchesQuery, useFavorites, useHistory } from "./browserHistory";
import { Palette } from "./Palette";
import { PERMISSION_DEFAULTS, type PermissionCategory } from "./browserPermissions";
import { DEVICE_PRESETS, presetDescription } from "./browserView";
import { Codicon } from "./icons";
import { IN_ELECTRON } from "./shortcuts";
import { dispatchBrowserAction, setState } from "./store";
import { S } from "./strings";
import { hint } from "./hint";


type Row = { key: string; title: string; url: string; section: string | null };

// 즐겨찾기를 맨 위에 한 묶음으로, 그 아래에 방문 기록을 날짜별로 놓는다. 입력한 낱말이 제목이나 주소에 들어야 남는다.
export function BrowserHistory({ tabKey }: { tabKey: string }) {
  const history = useHistory();
  const favorites = useFavorites();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rows = useMemo(() => {
    const list: Row[] = [];
    favorites
      .filter((f) => matchesQuery(f, query))
      .forEach((f, i) => list.push({ key: `fav:${f.url}`, title: f.title || f.url, url: f.url, section: i === 0 ? S.browserFavoritesSection : null }));
    for (const group of groupByDay(
      history.filter((v) => matchesQuery(v, query)),
      Date.now(),
    )) {
      group.items.forEach((v, i) => list.push({ key: `visit:${v.url}`, title: v.title || v.url, url: v.url, section: i === 0 ? group.label : null }));
    }
    return list;
  }, [history, favorites, query]);
  const active = Math.min(index, Math.max(rows.length - 1, 0));

  const choose = (row: Row | undefined) => {
    if (!row) return;
    setState({ overlay: null });
    // 대화상자가 닫히며 포커스를 돌려주는 일이 끝난 뒤에 열어야 주소창 포커스가 묻히지 않는다
    setTimeout(() => dispatchBrowserAction("navigate", row.url, tabKey), 0);
  };

  return (
    <Palette
      quickpick
      count={S.resultCount(rows.length)}
      label={S.browserHistoryTitle}
      placeholder={S.browserHistoryPlaceholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, rows.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing) choose(rows[active]);
      }}
      footer={null}
    >
      {rows.map((row, i) => (
        <button key={row.key} type="button" className="quickpick-row" data-history-option data-active={i === active || undefined} onClick={() => choose(row)}>
          <span className="quickpick-title">
            {row.title} <span className="quickpick-folder">{row.url}</span>
          </span>
          {row.section && <span className="quickpick-section">{row.section}</span>}
        </button>
      ))}
      {rows.length === 0 && <div className="quickpick-empty">{S.browserHistoryEmpty}</div>}
    </Palette>
  );
}

type StoredPermission = { category: string; decision: "allow" | "deny" | null; state: "allow" | "deny" | "ask" };
type Staged = Record<string, "allow" | "deny" | null>;

export function SitePermissions({ url }: { url: string }) {
  const host = hostOf(url);
  const native = window.agentNavNative;
  const managed = IN_ELECTRON && !!native?.browserPermissionsGet;
  const [stored, setStored] = useState<StoredPermission[] | null>(null);
  const [staged, setStaged] = useState<Staged>({});
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const [noOrigin, setNoOrigin] = useState(false);
  useEffect(() => {
    if (!managed) return;
    void native!.browserPermissionsGet!(url).then((result) => {
      if (!result.origin) setNoOrigin(true);
      setStored(result.items);
    });
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = S.browserPermissions.filter((item) => `${item.name} ${item.detail}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const active = Math.min(index, Math.max(rows.length - 1, 0));
  const current = (category: string) => (category in staged ? staged[category] : (stored?.find((s) => s.category === category)?.decision ?? null));
  const defaultOf = (category: string) => PERMISSION_DEFAULTS[category as PermissionCategory];
  const changes = Object.entries(staged).filter(([category, state]) => state !== (stored?.find((s) => s.category === category)?.decision ?? null));
  const stage = (category: string, state: "allow" | "deny" | null) => setStaged((prev) => ({ ...prev, [category]: state }));
  const save = () => {
    if (changes.length === 0) return;
    void native!.browserPermissionsSet!(url, changes.map(([category, state]) => ({ category, state }))).then(() => setState({ overlay: null }));
  };
  if (managed && noOrigin) {
    hint(S.browserPermissionsNoOrigin);
    setState({ overlay: null });
  }
  return (
    <Palette
      quickpick
      count={S.resultCount(rows.length)}
      label={S.browserPermissionsTitle(host)}
      placeholder={S.browserPermissionsFilter}
      query={filter}
      onQuery={(value) => {
        setFilter(value);
        setIndex(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, rows.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          if (changes.length > 0) save();
          else setState({ overlay: null });
        }
      }}
      footer={managed ? null : S.browserPermissionsNote}
      customButton={managed && changes.length > 0 ? { label: changes.length === 1 ? S.browserPermissionSaveOne : S.browserPermissionSaveMany(changes.length), onClick: save } : null}
    >
      {rows.map((item, i) => {
        const decision = managed ? current(item.category) : null;
        const effective = decision ?? defaultOf(item.category);
        const stateLabel = effective === "allow" ? S.browserPermissionAllowed : effective === "deny" ? S.browserPermissionBlocked : S.browserPermissionAsk;
        return (
          <div key={item.name} className="quickpick-row quickpick-permission" data-permission-option data-active={i === active || undefined} onClick={() => setIndex(i)}>
            <Codicon name={item.icon} size={16} />
            <span className="quickpick-title">
              {item.name}
              <span className="quickpick-detail">{item.detail}</span>
            </span>
            {managed ? (
              <span className="quickpick-buttons">
                {effective !== "allow" && (
                  <button type="button" className="quickpick-button" aria-label={S.browserPermissionAllow} title={S.browserPermissionAllow} data-action="allow" onClick={() => stage(item.category, "allow")}>
                    <Codicon name="check" size={16} />
                  </button>
                )}
                {effective !== "deny" && (
                  <button type="button" className="quickpick-button" aria-label={S.browserPermissionBlock} title={S.browserPermissionBlock} data-action="deny" onClick={() => stage(item.category, "deny")}>
                    <Codicon name="circle-slash" size={16} />
                  </button>
                )}
                {effective !== "ask" && (
                  <button type="button" className="quickpick-button" data-state={decision ? "set" : "default"} aria-label={decision ? stateLabel : S.browserPermissionDefault(stateLabel)} title={decision ? stateLabel : S.browserPermissionDefault(stateLabel)} data-action="reset" onClick={() => stage(item.category, decision ? null : effective)}>
                    <Codicon name={effective === "allow" ? "check" : "circle-slash"} size={16} />
                  </button>
                )}
              </span>
            ) : (
              <span className="quickpick-section">{S.browserPermissionByBrowser}</span>
            )}
          </div>
        );
      })}
    </Palette>
  );
}

// Emulate Device... 선택창. 줄은 "이름 + 393×852 • mobile" 이고, 고르면 그 탭의 에뮬레이션이 프리셋으로 바뀐다.
export function DevicePresets({ tabKey }: { tabKey: string }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rows = DEVICE_PRESETS.filter((p) => `${p.name} ${presetDescription(p)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = Math.min(index, Math.max(rows.length - 1, 0));
  const choose = (name: string | undefined) => {
    if (!name) return;
    setState({ overlay: null });
    setTimeout(() => dispatchBrowserAction("applyPreset", undefined, tabKey, name), 0);
  };
  return (
    <Palette
      quickpick
      count={S.resultCount(rows.length)}
      label={S.emuPresetsTitle}
      placeholder={S.emuPresetPlaceholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, rows.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing) choose(rows[active]?.name);
      }}
      footer={null}
    >
      {rows.map((preset, i) => (
        <button key={preset.name} type="button" className="quickpick-row" data-device-option data-active={i === active || undefined} onClick={() => choose(preset.name)}>
          <span className="quickpick-title">
            {preset.name} <span className="quickpick-folder">{presetDescription(preset)}</span>
          </span>
        </button>
      ))}
    </Palette>
  );
}

// Emulate User Agent... 입력창. Enter 로 적용하고 비우면 기본 사용자 에이전트로 돌아간다.
export function UserAgentPrompt({ tabKey, value }: { tabKey: string; value: string }) {
  const [text, setText] = useState(value);
  return (
    <Palette
      quickpick
      label={S.emuUserAgentTitle}
      placeholder={S.emuUserAgentPrompt}
      query={text}
      onQuery={setText}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        setState({ overlay: null });
        setTimeout(() => dispatchBrowserAction("setUserAgent", undefined, tabKey, text.trim()), 0);
      }}
      footer={null}
    >
      {null}
    </Palette>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
