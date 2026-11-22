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

function useMiniBridge() {
  const gone = useStore((s) => s.connected && s.settings !== null && s.panes[0]?.kind !== "agent");

  useEffect(() => {
    if (gone) void window.agentNavNative?.quickEntrySwitch?.(null);
  }, [gone]);

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
