import { useEffect, useState } from "react";
import { Refresh, Warning } from "./icons";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

type NativeDaemonState = { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number };

// 처음 연결된 뒤 데몬과 끊긴 동안 창 맨 위에 뜨는 띠. 끊겼다 이어지면 store 가 상태를 다시 읽어 오므로(initStore) 띠만 사라지면 된다.
// 앱이 데몬을 다시 띄우는 중이면 그 횟수를, 포기했으면 Restart Daemon 단추를 보인다. 브라우저로 붙은 창은 다시 연결하는 중이라는 말만 보인다.
const SHOW_AFTER_MS = 600;

export function DaemonBanner() {
  const connected = useStore((s) => s.connected);
  const [everConnected, setEverConnected] = useState(connected);
  const [late, setLate] = useState(false);
  const [native, setNative] = useState<NativeDaemonState | null>(null);
  const [restarting, setRestarting] = useState(false);
  const down = everConnected && !connected;

  useEffect(() => {
    if (connected) setEverConnected(true);
  }, [connected]);

  // 끊긴 지 잠깐은 띄우지 않는다(이어졌다 끊기는 짧은 순간에 번쩍이지 않게).
  useEffect(() => {
    if (!down) {
      setLate(false);
      setNative(null);
      setRestarting(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), SHOW_AFTER_MS);
    const bridge = window.agentNavNative;
    void bridge?.daemonState?.().then(setNative).catch(() => undefined);
    const off = bridge?.onDaemonState?.(setNative);
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [down]);

  if (!down || !late) return null;
  return native?.state === "stopped" ? <StoppedBar busy={restarting} onRestart={() => restart(setRestarting)} /> : <ReconnectingBar native={native} />;
}

function ReconnectingBar({ native }: { native: NativeDaemonState | null }) {
  return (
    <div className="editor-banner daemon-banner" role="status" data-testid="daemon-reconnecting">
      <span className="editor-banner-icon spin">
        <Refresh size={14} />
      </span>
      <span className="editor-banner-text">
        {S.daemonReconnecting}
        {native && native.attempt > 0 && <span className="faint"> {S.daemonRestartAttempt(native.attempt, native.maxAttempts)}</span>}
      </span>
    </div>
  );
}

function StoppedBar({ busy, onRestart }: { busy: boolean; onRestart: () => void }) {
  return (
    <div className="editor-banner daemon-banner" role="alert" data-testid="daemon-stopped">
      <span className="editor-banner-icon">
        <Warning size={14} />
      </span>
      <span className="editor-banner-text">{S.daemonStopped}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={onRestart}>
        {S.daemonRestartButton}
      </Button>
    </div>
  );
}

// 데몬이 없으니 진행 중인 세션을 묻는 확인은 건너뛴다. 메인이 데몬을 띄우고 창을 다시 읽는다.
function restart(setBusy: (busy: boolean) => void) {
  setBusy(true);
  void window.agentNavNative
    ?.restartDaemon?.()
    .catch(() => false)
    .then((started) => {
      if (!started) setBusy(false);
    });
}
