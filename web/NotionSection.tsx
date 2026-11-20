import "./notion.css";
import { useRef, useState, type DragEvent } from "react";
import { isNotionUrl, notionAppUrl, sameNotionPage } from "../shared/notionLink";
import type { NotionPin } from "../shared/notionPins";
import { hint } from "./hint";
import { ChevronDown, ChevronRight, Codicon, More, Plus } from "./icons";
import { openNotionScreen, useNotionScreen } from "./notionScreen";
import { guessTitle, moveNotionPin, openNotionInApp, pinNotionPage, renameNotionPin, setNotionCollapsed, unpinNotionPage, useNotion } from "./notionStore";
import { N } from "./notionStrings";
import { SectionMoveItems } from "./SectionMoveItems";
import { flash, useStore } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

// 사이드바의 Notion 구역. 고정한 페이지를 보이고, 누르면 Browser 탭으로 연다(이미 열려 있으면 그 탭).
// 구역 머리의 +, Browser 탭의 Pin to Sidebar, 대화 속 링크 우클릭(web/NotionLinkMenu.tsx)으로 고정한다. 목록은 데몬(notion.pins.*)에 저장돼 재시작해도 남는다.
export function NotionSection() {
  const collapsed = useNotion((s) => s.collapsed);
  const pins = useNotion((s) => s.pins);
  const [adding, setAdding] = useState(false);

  return (
    <section className="notion-section" aria-label={N.sectionAria} data-collapsed={collapsed || undefined}>
      <div className="sessions-header notion-section-head">
        <button type="button" className="notion-section-toggle" aria-expanded={!collapsed} onClick={() => setNotionCollapsed(!collapsed)}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="sessions-title">{N.section}</span>
          {collapsed && (pins?.length ?? 0) > 0 && <span className="notion-count">{pins?.length}</span>}
        </button>
        <span className="spacer" />
        <Button
          size="icon"
          aria-label={N.add}
          title={N.add}
          onClick={() => {
            setNotionCollapsed(false);
            setAdding((v) => !v);
          }}
        >
          <Plus />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label={N.sectionActions} title={N.sectionActions}>
              <More />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="session-menu" data-menu="more">
            <SectionMoveItems id="notion" />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!collapsed && adding && <AddPin onDone={() => setAdding(false)} />}
      {!collapsed && <SectionBody pins={pins} />}
    </section>
  );
}

function SectionBody({ pins }: { pins: NotionPin[] | null }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [mark, setMark] = useState<{ id: string; side: "before" | "after" } | null>(null);
  if (pins === null) return <div className="notion-note">{N.empty}</div>;
  if (pins.length === 0) return <div className="notion-note">{N.empty}</div>;

  // 놓은 자리: 대상 행의 위/아래. moveNotionPin 의 index 는 옮기는 항목을 뺀 목록 기준이다.
  const drop = () => {
    if (!dragId || !mark) return;
    const from = pins.findIndex((p) => p.id === dragId);
    const over = pins.findIndex((p) => p.id === mark.id);
    setDragId(null);
    setMark(null);
    if (from < 0 || over < 0 || from === over) return;
    const slot = mark.side === "before" ? over : over + 1;
    const index = slot > from ? slot - 1 : slot;
    if (index !== from) void moveNotionPin(dragId, index);
  };

  return (
    <div className="notion-body" role="list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setMark(null)}>
      {pins.map((pin) => (
        <PinRow
          key={pin.id}
          pin={pin}
          dragging={dragId === pin.id}
          mark={mark?.id === pin.id ? mark.side : null}
          onDragStart={() => setDragId(pin.id)}
          onDragEnd={() => {
            setDragId(null);
            setMark(null);
          }}
          onDragOver={(side) => dragId && dragId !== pin.id && setMark({ id: pin.id, side })}
          onDrop={drop}
        />
      ))}
    </div>
  );
}

function PinRow({ pin, dragging, mark, onDragStart, onDragEnd, onDragOver, onDrop }: { pin: NotionPin; dragging: boolean; mark: "before" | "after" | null; onDragStart: () => void; onDragEnd: () => void; onDragOver: (side: "before" | "after") => void; onDrop: () => void }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const active = useStore((s) => (s.centerView === "notion" ? false : s.tabs.some((t) => t.key === s.activeTabKey && t.kind === "browser" && sameNotionPage(t.url, pin.url))));
  const centerNotion = useStore((s) => s.centerView === "notion");
  const showing = useNotionScreen((n) => n.url !== null && sameNotionPage(n.url, pin.url)) && centerNotion;

  const over = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    onDragOver(event.clientY < box.top + box.height / 2 ? "before" : "after");
  };

  return (
    <div
      className="notion-row"
      role="listitem"
      draggable={!renaming}
      data-active={active || showing || undefined}
      data-menu={menu || undefined}
      data-dragging={dragging || undefined}
      data-drop={mark ?? undefined}
      data-pin-id={pin.id}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", pin.url);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={over}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(true);
      }}
    >
      {renaming ? (
        <RenameInput pin={pin} onDone={() => setRenaming(false)} />
      ) : (
        <button type="button" className="notion-item" title={pin.url} onClick={() => openNotionScreen(pin.url)}>
          <span className="notion-icon">{pin.icon ? <span className="notion-emoji">{pin.icon}</span> : <Codicon name={pin.kind === "database" ? "table" : "file"} size={14} />}</span>
          <span className="notion-title">{pin.title}</span>
        </button>
      )}
      {!renaming && (
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button size="icon" className="notion-more" aria-label={N.rowActions(pin.title)} title={N.rowActions(pin.title)}>
              <More />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="session-menu" data-menu="notion-pin">
            <DropdownMenuItem onSelect={() => openNotionScreen(pin.url)}>{N.openInView}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openNotionInApp(pin.url)}>{N.openInTab}</DropdownMenuItem>
            <DropdownMenuItem disabled={notionAppUrl(pin.url) === null} onSelect={() => window.open(notionAppUrl(pin.url) ?? pin.url, "_blank", "noopener")}>
              {N.openInNotion}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setRenaming(true)}>{N.rename}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(pin.url).then(() => hint(N.copied, undefined, { check: true }), () => flash(N.copyLink))}>{N.copyLink}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => void unpinNotionPage(pin.id)}>
              {N.unpinFromSidebar}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function RenameInput({ pin, onDone }: { pin: NotionPin; onDone: () => void }) {
  const [value, setValue] = useState(pin.title);
  const finished = useRef(false);
  const commit = () => {
    if (finished.current) return;
    finished.current = true;
    const title = value.trim();
    if (title && title !== pin.title) void renameNotionPin(pin.id, title);
    onDone();
  };
  return (
    <input
      className="notion-rename"
      aria-label={N.renameAria}
      value={value}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          finished.current = true;
          onDone();
        }
      }}
    />
  );
}

// + 로 붙여 넣는 주소. 제목은 주소에서 추정한 이름으로 시작하고, 그 페이지를 Browser 탭에서 열면 읽은 제목으로 바뀐다.
function AddPin({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const url = value.trim();
    if (!isNotionUrl(url)) {
      setError(N.addInvalid);
      return;
    }
    if (await pinNotionPage({ title: guessTitle(url), url })) onDone();
  };
  return (
    <div className="notion-add">
      <input
        className="input notion-add-input"
        aria-label={N.add}
        placeholder={N.addPlaceholder}
        value={value}
        autoFocus
        spellCheck={false}
        data-invalid={error ? "" : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") void submit();
          else if (e.key === "Escape") onDone();
        }}
      />
      {error && <span className="xs error-text">{error}</span>}
    </div>
  );
}
