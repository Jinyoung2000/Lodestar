import { useCallback, useEffect, useState } from "react";
import type { LinearError, LinearStatus } from "../shared/linear";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Button } from "./ui/button";

// LINEAR: Settings 의 Linear 항목. 연결 상태(연결됨이면 이름과 이메일), 키 입력과 저장, 연결 해제.
// 키는 입력칸 안에만 있고 저장하면 비운다. 저장은 데몬이 Linear 로 확인한 뒤 키체인에 쓴다. 이 컴포넌트는 키를 어디에도 보관하지 않는다.

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
  // 설정을 열 때는 캐시(1분) 대신 지금 상태를 읽는다. 키가 폐기됐다면 여기서 바로 보인다.
  useEffect(() => refresh(true), [refresh]);

  // 저장하면 데몬이 먼저 Linear 에 이 키로 물어본다. 통과해야 키체인에 쓰고, 안 되면 이유만 입력칸 아래에 보인다(원래 저장된 키와 상태 줄은 그대로).
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
