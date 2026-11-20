import { useState } from "react";
import type { McpStatus } from "../shared/protocol";
import { CLAUDE_AI_CONNECTORS_URL, isClaudeAiServer } from "../shared/mcp";
import { Refresh } from "./icons";
import { flash, refreshMeta, reconnectMcp, toggleMcp, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { hint } from "./hint";

// 설정 패널의 MCP 목록. 서버마다 상태, 재연결, 켜기/끄기가 있고, 인증이 필요하면 안내가 붙는다.
export function McpSection() {
  const meta = useStore((s) => s.meta);
  const refreshing = useStore((s) => s.metaRefreshing);
  return (
    <div className="status-section">
      <div className="status-row">
        <span className="spacer" />
        <Button size="sm" disabled={refreshing} onClick={() => void refreshMeta()}>
          <span className={refreshing ? "spin" : "inline-flex"}>
            <Refresh size={14} />
          </span>
          {S.mcpRefreshAll}
        </Button>
      </div>
      <div className="status-row muted small mcp-scope-note">{S.mcpScopeNote}</div>
      {(meta?.mcp ?? []).map((m) => (
        <McpServerRow key={m.name} server={m} />
      ))}
      {meta && !meta.mcp.length && <div className="status-row muted small">{meta.error ? S.mcpUnavailable : meta.fetchedAt ? S.noMcpServers : S.loading}</div>}
    </div>
  );
}

function McpServerRow({ server }: { server: McpStatus }) {
  const busy = useStore((s) => s.mcpBusy[server.name]);
  const disabled = server.status === "disabled";
  return (
    <div className="mcp-server" data-testid={`mcp-${server.name}`}>
      <div className="status-row small">
        <span className="dot" data-state={busy === "reconnect" || busy === "enable" ? "pending" : server.status} />
        <span className="mono">{server.name}</span>
        <span className="spacer" />
        <span className="muted" data-testid="mcp-status">
          {server.status}
          {server.status === "connected" && typeof server.toolCount === "number" ? `, ${S.mcpTools(server.toolCount)}` : ""}
        </span>
        {!disabled && (
          <Button size="sm" disabled={!!busy} onClick={() => void reconnectMcp(server.name)}>
            <span className={busy === "reconnect" ? "spin" : "inline-flex"}>
              <Refresh size={14} />
            </span>
            {busy === "reconnect" ? S.mcpReconnecting : S.mcpReconnect}
          </Button>
        )}
        <Button size="sm" disabled={!!busy} onClick={() => void toggleMcp(server.name, disabled)}>
          {disabled ? (busy === "enable" ? S.mcpEnabling : S.mcpEnable) : busy === "disable" ? S.mcpDisabling : S.mcpDisable}
        </Button>
      </div>
      <McpDetail server={server} />
      {server.status === "connected" && (server.tools?.length ?? 0) > 0 && <McpToolList server={server} />}
    </div>
  );
}

// 서버가 알려 준 도구 이름과 설명. 개수 글자 아래에서 펼치고 접는다.
function McpToolList({ server }: { server: McpStatus }) {
  const [open, setOpen] = useState(false);
  const tools = server.tools ?? [];
  return (
    <div className="mcp-tools small">
      <button type="button" className="mcp-tools-toggle" aria-expanded={open} data-testid={`mcp-tools-toggle-${server.name}`} onClick={() => setOpen(!open)}>
        {open ? S.mcpHideTools : S.mcpShowTools(tools.length)}
      </button>
      {open && (
        <ul className="mcp-tool-list" aria-label={server.name}>
          {tools.map((tool) => (
            <li key={tool.name} className="mcp-tool">
              <span className="mono mcp-tool-name">{tool.name}</span>
              {tool.description && (
                <span className="muted mcp-tool-desc" title={tool.description}>
                  {tool.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 서버 한 줄 아래에 붙는 설명: 마지막 동작의 결과, 실패 사유, 인증이 필요할 때의 다음 단계.
export function McpDetail({ server }: { server: McpStatus }) {
  const note = useStore((s) => s.mcpNotes[server.name]);
  return (
    <div className="mcp-detail small">
      {server.status === "failed" && server.error && <div className="error-text">{server.error}</div>}
      {note && note.text !== server.error && (
        <div className={note.ok ? "muted" : "error-text"} data-testid="mcp-note">
          {note.text}
        </div>
      )}
      {server.status === "needs-auth" && <McpAuthHelp server={server} />}
    </div>
  );
}

// 인증은 앱 안에서 할 수 없다. 실제로 확인한 대로 CLI 는 재연결 때 인증 URL 을 주지 않는다(Elicitation 도 오지 않는다).
// claude.ai 커넥터는 claude.ai 의 설정 페이지로, 그 밖의 서버는 터미널의 /mcp 로 보낸다.
function McpAuthHelp({ server }: { server: McpStatus }) {
  if (isClaudeAiServer(server)) {
    return (
      <div className="mcp-auth">
        <span className="muted">{S.mcpAuthClaudeAiHint}</span>
        <Button asChild size="sm" variant="secondary">
          <a href={CLAUDE_AI_CONNECTORS_URL} target="_blank" rel="noopener noreferrer" data-testid="mcp-auth-link">
            {S.mcpAuthClaudeAi}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <div className="mcp-auth">
      <span className="muted">{S.mcpAuthLocal}</span>
      <Button size="sm" variant="secondary" data-testid="mcp-copy-command" onClick={() => void copyCommand()}>
        {S.mcpCopyCommand}
      </Button>
    </div>
  );
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText("claude");
    hint(S.mcpCopied, undefined, { check: true });
  } catch {
    flash(S.mcpCopyFailed);
  }
}
