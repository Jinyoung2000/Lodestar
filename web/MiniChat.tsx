import "./miniChat.css";
import { useEffect, type ReactNode } from "react";
import { ChevronDown, Close, Codicon, DotSpinner, External, Plus } from "./icons";
import { answerToolApproval, pendingToolApproval } from "./approvalKeys";
import { strokeOf, type KeyInput } from "./keymap";
import { focusApproval } from "./paneNav";
import { cycleEffort } from "./Pickers";
import { recentSessions } from "./quickEntryModel";
import { interruptAgent } from "./sessionActions";
import { activeAgent, setState, useStore } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";


const SWITCH_LIMIT = 8;

export function MiniFrame({ children }: { children: ReactNode }) {
  useMiniBridge();
  return (
    <div className="mini-root">
      <div className="mini-card" role="dialog" aria-label={S.miniChatAria}>
        <MiniHeader />
        <div className="mini-body">{children}</div>
      </div>
    </div>
  );
}

function MiniHeader() {
  const agentId = useStore((s) => (s.panes[0]?.kind === "agent" ? s.panes[0].agentId : null));
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === agentId);
  const title = agent?.title || S.miniChatUntitled;
  const others = recentSessions(agents, SWITCH_LIMIT + 1).filter((a) => a.id !== agentId).slice(0, SWITCH_LIMIT);

  return (
    <div className="mini-header">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="mini-title" aria-label={S.miniChatSessionsAria(title)}>
            {agent?.status === "running" && <DotSpinner size={12} />}
            <span className="mini-title-text">{title}</span>
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="mini-menu">
          <DropdownMenuItem onSelect={() => void window.agentNavNative?.quickEntrySwitch?.(null)}>
            <Plus size={14} />
            <span>{S.miniChatNew}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="mini-menu-title">{S.miniChatRecent}</div>
          {others.length === 0 && <div className="mini-menu-empty">{S.miniChatNoSessions}</div>}
          {others.map((other) => (
            <DropdownMenuItem key={other.id} onSelect={() => void window.agentNavNative?.quickEntrySwitch?.(other.id)}>
              <Codicon name="comment" size={14} />
              <span className="mini-menu-label">{other.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="mini-actions">
        <button type="button" className="mini-button" aria-label={S.miniChatOpenInApp} title={S.miniChatOpenInApp} disabled={!agentId} onClick={() => agentId && void window.agentNavNative?.quickEntryOpenInMain?.(agentId)}>
          <External size={14} />
        </button>
        <button type="button" className="mini-button" aria-label={S.miniChatHide} title={S.miniChatHide} onClick={() => void window.agentNavNative?.quickEntryClose?.()}>
          <Close size={14} />
        </button>
      </div>
    </div>
  );
}

// 패널과 Electron 메인 사이의 연결: 세션이 사라지면 입력 막대로, Esc 로 숨기기.
function useMiniBridge() {
  const gone = useStore((s) => s.connected && s.settings !== null && s.panes[0]?.kind !== "agent");

  // 묶인 세션이 지워졌으면(스토어가 그 칸을 새 세션 칸으로 바꿨다) 입력 막대로 돌아간다.
  useEffect(() => {
    if (gone) void window.agentNavNative?.quickEntrySwitch?.(null);
  }, [gone]);

  // Esc: 메뉴, 팝업, 입력창 자동완성이 먼저 받으면(defaultPrevented) 그쪽이 닫히고 패널은 그대로 둔다.
  // 이 화면에는 메인 창의 단축키 표(web/shortcuts.ts)가 없다. 승인 카드, 중단 단추, 모델과 effort 칩이 알리는 키는 여기서 받는다.
  // ⇧⌘M, ⇧⌘I 는 앱 메뉴 가속키라 keydown 이 오지 않고 Electron 메인이 agent-nav:key 로 넘긴다(shared/quickEntry.ts quickInputPolicy).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") void window.agentNavNative?.quickEntryClose?.();
      else if (runMiniKey(e)) e.preventDefault();
    };
    const onForwarded = (event: Event) => runMiniKey((event as CustomEvent<KeyInput>).detail);
    window.addEventListener("keydown", onKey);
    window.addEventListener("agent-nav:key", onForwarded);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("agent-nav:key", onForwarded);
    };
  }, []);
}

// 처리했으면 true. 메인 창 표와 같은 키와 뜻이다: ⌘Enter 허용, ⌥⌘Enter 건너뛰기, ⇧⌘A 승인 카드로 포커스, ⌃C 중단, ⇧⌘M 모델, ⇧⌘I effort.
function runMiniKey(input: KeyInput): boolean {
  const stroke = strokeOf(input);
  if ((stroke === "Meta+Enter" || stroke === "Alt+Meta+Enter") && pendingToolApproval()) {
    answerToolApproval(stroke === "Meta+Enter" ? "allow" : "deny");
    return true;
  }
  if (stroke === "Shift+Meta+KeyA") return focusApproval();
  if (stroke === "Ctrl+KeyC") {
    const agent = activeAgent();
    if (agent && (agent.status === "running" || agent.status === "waiting")) interruptAgent(agent.id);
    return !!agent;
  }
  if (stroke === "Shift+Meta+KeyM") {
    setState({ overlay: { kind: "models" } });
    return true;
  }
  if (stroke === "Shift+Meta+KeyI") {
    cycleEffort();
    return true;
  }
  return false;
}
