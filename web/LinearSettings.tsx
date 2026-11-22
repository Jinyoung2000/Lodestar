import { useCallback, useEffect, useState } from "react";
import type { LinearError, LinearStatus } from "../shared/linear";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Button } from "./ui/button";

export function LinearSettings() {
  const { status, busy, problem, refresh, save, disconnect } = useLinear();
  const [key, setKey] = useState("");

  const submit = () => {
    if (!key.trim() || busy) return;
    void save(key.trim()).then((connected) => connected && setKey(""));
  };

  return (
    <div className="setting-mobile">
      <StatusLine status={status} />
      <div className="setting-mobile-actions">
        <input
          type="password"
          className="input setting-text-input"
          aria-label={S.linearKeyLabel}
          placeholder={S.linearKeyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && submit()}
        />
        <Button variant="secondary" size="default" disabled={!key.trim() || busy} onClick={submit}>
          {busy ? S.linearSaving : S.linearSave}
        </Button>
      </div>
      {problem && (
        <div className="setting-problem" role="status">
          {problem}
        </div>
      )}
      <div className="muted">{S.linearKeyHelp}</div>
      <div className="setting-mobile-actions">
        {status && !status.connected && status.error.kind !== "noKey" && status.error.kind !== "invalidKey" && (
          <Button size="default" disabled={busy} onClick={() => refresh(true)}>
            {S.linearRetry}
          </Button>
        )}
        {status && (status.connected || status.error.kind !== "noKey") && (
          <Button size="default" disabled={busy} onClick={() => void disconnect()}>
            {S.linearDisconnect}
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: LinearStatus | null }) {
  if (!status) return <div className="setting-daemon-line" />;
  if (status.connected) {
    return (
      <div className="setting-daemon">
        <div className="setting-daemon-line">
          <span className="dot" data-state="ok" />
          <span>{S.linearConnectedAs(status.viewer.name, status.viewer.email)}</span>
        </div>
        {status.organization && <div className="muted">{S.linearWorkspace(status.organization.name)}</div>}
      </div>
    );
  }
  const noKey = status.error.kind === "noKey";
  return (
    <div className="setting-daemon">
      <div className="setting-daemon-line">
        <span className="dot" data-state={noKey ? "off" : "error"} />
        <span>{noKey ? S.linearNoKey : errorText(status.error)}</span>
      </div>
    </div>
  );
}

function errorText(error: LinearError): string {
  if (error.kind === "invalidKey") return S.linearKeyProblem;
  const base = S.linearErrorByKind[error.kind];
  return error.retryAfterSec ? `${base} ${S.linearRetryAfter(error.retryAfterSec)}` : base;
}

function useLinear() {
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback((force: boolean) => {
    void rpc
      .call("linear.status", { force })
      .then(setStatus)
      .catch((error: Error) => setStatus({ connected: false, error: { kind: "server", message: error.message } }));
  }, []);
  useEffect(() => refresh(true), [refresh]);

  const save = async (key: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await rpc.call("linear.setKey", { key, confirmed: true });
      if (next.connected) setStatus(next);
      else setProblem(`${next.error.message} ${S.linearNotSaved}`);
      return next.connected;
    } catch (error) {
      setProblem(`${(error as Error).message} ${S.linearNotSaved}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await rpc.call("linear.clearKey", { confirmed: true }));
    } catch (error) {
      setStatus({ connected: false, error: { kind: "server", message: (error as Error).message } });
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, problem, refresh, save, disconnect };
}
