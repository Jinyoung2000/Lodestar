import { useEffect, useState } from "react";
import { Refresh, Warning } from "./icons";
import { localNative } from "./remote";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

type NativeDaemonState = { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number };

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

  useEffect(() => {
    if (!down) {
      setLate(false);
      setNative(null);
      setRestarting(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), SHOW_AFTER_MS);
    const bridge = localNative();
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

function restart(setBusy: (busy: boolean) => void) {
  setBusy(true);
  void window.agentNavNative
    ?.restartDaemon?.()
    .catch(() => false)
    .then((started) => {
      if (!started) setBusy(false);
    });
}
