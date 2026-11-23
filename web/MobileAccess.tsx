import { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import type { MobileRelayStatus, MobileStatus, PairingOffer } from "../shared/mobile";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Button } from "./ui/button";

export function MobileAccess() {
  const enabled = useEnabled();
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("mobile.status", {}).then(setStatus).catch((error: Error) => setProblem(error.message));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh, enabled]);
  useEffect(() => {
    if (!enabled) setOffer(null);
  }, [enabled]);

  const createCode = () => {
    setProblem(null);
    void rpc
      .call("mobile.pairingCode", {})
      .then((next) => {
        setOffer(next);
        refresh();
      })
      .catch((error: Error) => setProblem(error.message));
  };
  const revoke = (id: string) => void rpc.call("mobile.revokeDevice", { id }).then(setStatus).catch((error: Error) => setProblem(error.message));

  if (!enabled) return <div className="setting-empty">{S.mobileOffNote}</div>;
  return (
    <div className="setting-mobile">
      <div className="setting-mobile-status">
        <div className="setting-daemon-line">
          <span className="dot" data-state={status?.listening ? "ok" : "off"} />
          <span>{status?.listening ? S.mobileListening(status.bind === "0.0.0.0" ? (status.hosts[0]?.address ?? status.bind) : status.bind, status.port) : (status?.error ?? S.mobileNotListening)}</span>
        </div>
        {status && status.relay.state !== "off" && <RelayLine relay={status.relay} />}
      </div>
      {status && status.hosts.length === 0 && status.listening && <div className="setting-warning">{S.mobileNoNetwork}</div>}
      <div className="setting-mobile-actions">
        <Button variant="secondary" size="default" disabled={!status?.listening} onClick={createCode}>
          {offer ? S.mobileNewCode : S.mobileCreateCode}
        </Button>
      </div>
      {problem && <div className="setting-problem">{problem}</div>}
      {offer && <PairingCard offer={offer} onExpired={() => setOffer(null)} />}
      <div className="setting-mobile-devices">
        <div className="setting-mobile-heading">{S.mobileDevices}</div>
        {status?.devices.length === 0 && <div className="setting-empty">{S.mobileNoDevices}</div>}
        {status?.devices.map((device) => (
          <div key={device.id} className="setting-subrow">
            <span className="dot" data-state={device.online ? "ok" : "off"} title={device.online ? S.mobileOnline : S.mobileOffline} />
            <label>{device.name}</label>
            <span className="muted">{device.online && device.route ? S.mobileRoute[device.route] : device.lastSeenAt ? S.mobileLastSeen(new Date(device.lastSeenAt).toLocaleString()) : S.mobileNeverSeen}</span>
            <Button size="sm" onClick={() => revoke(device.id)}>
              {S.mobileRemove}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RelayLine({ relay }: { relay: MobileRelayStatus }) {
  const failed = relay.state === "error" || (relay.state === "connecting" && relay.error !== null);
  const dot = relay.state === "online" ? "ok" : failed ? "error" : relay.state === "unconfigured" ? "off" : "pending";
  const text = relay.state === "online" ? S.mobileRelayOnline : relay.state === "unconfigured" ? S.mobileRelayUnconfigured : failed ? S.mobileRelayFailed(relay.error ?? "") : S.mobileRelayConnecting;
  return (
    <div className="setting-daemon-line">
      <span className="dot" data-state={dot} />
      <span>{text}</span>
    </div>
  );
}

function useEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => void rpc.call("settings.get", {}).then((s) => alive && setEnabled(s.mobileAccess === true)).catch(() => {});
    read();
    const off = rpc.onEvent((event) => {
      if (event.type === "settings") setEnabled(event.settings.mobileAccess === true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return enabled;
}

function PairingCard({ offer, onExpired }: { offer: PairingOffer; onExpired: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, offer.expiresAt - Date.now()));
  useEffect(() => {
    const tick = () => {
      const remaining = offer.expiresAt - Date.now();
      if (remaining <= 0) onExpired();
      else setLeft(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [offer, onExpired]);
  const seconds = Math.ceil(left / 1000);
  return (
    <div className="pairing-card">
      <QrCode text={offer.uri} />
      <div className="pairing-details">
        <div className="pairing-code" aria-label={S.mobileCode}>
          {offer.code}
        </div>
        <div className="muted">{S.mobileCodeExpires(Math.floor(seconds / 60), String(seconds % 60).padStart(2, "0"))}</div>
        <div className="pairing-manual-label muted">{S.mobileManual}</div>
        <code className="pairing-manual">{offer.manual}</code>
        {offer.relay && <div className="muted">{S.mobileRelayTypingNote}</div>}
        {offer.hosts.length > 1 && <div className="muted">{S.mobileOtherAddresses(offer.hosts.slice(1).map((h) => h.address).join(", "))}</div>}
      </div>
    </div>
  );
}

function QrCode({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let path = "";
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
  return (
    <svg className="pairing-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={S.mobileQrLabel} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
