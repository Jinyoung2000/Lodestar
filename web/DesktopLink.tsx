import { useCallback, useEffect, useState } from "react";
import type { DesktopLinkStatus, LinkOfferResult, LinkRemote, LinkRemoteCheck } from "../shared/desktopLink";
import { REMOTE_ID } from "./remote";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Button } from "./ui/button";

const STATUS_POLL_MS = 4000;
const CHECK_POLL_MS = 15_000;

function useLinkStatus() {
  const [status, setStatus] = useState<DesktopLinkStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (REMOTE_ID) return;
    void rpc.call("desktopLink.status", {}).then(setStatus).catch((error: Error) => setProblem(error.message));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { status, setStatus, problem, setProblem, refresh };
}

export function DesktopLinkIncoming() {
  const { status, setStatus, problem, setProblem, refresh } = useLinkStatus();
  const [offer, setOffer] = useState<LinkOfferResult | null>(null);

  if (REMOTE_ID) return <div className="setting-empty">{S.desktopLinkRemoteNote}</div>;
  if (status && !status.enabled) return <div className="setting-empty">{S.desktopLinkOffNote}</div>;

  const createText = () => {
    setProblem(null);
    void rpc
      .call("desktopLink.pairingOffer", {})
      .then((next) => {
        setOffer(next);
        refresh();
      })
      .catch((error: Error) => setProblem(error.message));
  };
  const revoke = (id: string) => void rpc.call("desktopLink.revokePeer", { id }).then(setStatus).catch((error: Error) => setProblem(error.message));

  return (
    <div className="setting-mobile">
      <div className="setting-daemon-line link-status-line">
        <span className="dot" data-state={status?.listening ? "ok" : "off"} />
        <span>{status?.listening ? S.desktopLinkListening(status.hosts[0]?.address ?? "0.0.0.0", status.port) : (status?.error ?? S.desktopLinkNotListening)}</span>
        {status && (
          <span className="link-fingerprint muted">
            {S.desktopLinkFingerprint} <span className="mono">{status.fingerprint}</span>
          </span>
        )}
      </div>
      {status && status.hosts.length === 0 && status.listening && <div className="setting-warning">{S.mobileNoNetwork}</div>}
      <div className="setting-mobile-actions">
        <Button variant="secondary" size="default" disabled={!status?.listening} onClick={createText}>
          {offer ? S.desktopLinkNewText : S.desktopLinkCreateText}
        </Button>
      </div>
      {problem && <div className="setting-problem">{problem}</div>}
      {offer && <OfferCard key={offer.text} offer={offer} onExpired={() => setOffer(null)} />}
      <div className="setting-mobile-devices">
        <div className="setting-mobile-heading">{S.desktopLinkPeers}</div>
        {status?.peers.length === 0 && <div className="setting-empty">{S.desktopLinkNoPeers}</div>}
        {status?.peers.map((peer) => (
          <div key={peer.id} className="setting-subrow link-row">
            <span className="dot" data-state={peer.online ? "ok" : "off"} title={peer.online ? S.desktopLinkPeerOnline : S.desktopLinkPeerOffline} />
            <div className="link-row-text">
              <span className="link-row-name">{peer.name}</span>
              <span className="link-row-detail mono">{peer.fingerprint}</span>
            </div>
            <span className="muted">{peer.online ? S.desktopLinkPeerOnline : peer.lastSeenAt ? S.desktopLinkLastSeen(new Date(peer.lastSeenAt).toLocaleString()) : S.desktopLinkNeverSeen}</span>
            <Button size="sm" onClick={() => revoke(peer.id)}>
              {S.desktopLinkRemove}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OfferCard({ offer, onExpired }: { offer: LinkOfferResult; onExpired: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, offer.expiresAt - Date.now()));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const tick = () => {
      const remaining = offer.expiresAt - Date.now();
      if (remaining <= 0) onExpired();
      else setLeft(remaining);
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [offer, onExpired]);
  const seconds = Math.ceil(left / 1000);
  const copy = () => void navigator.clipboard.writeText(offer.text).then(() => setCopied(true));
  return (
    <div className="pairing-card">
      <div className="pairing-details">
        <code className="pairing-manual link-offer-text" aria-label={S.desktopLinkTextLabel}>
          {offer.text}
        </code>
        <div className="link-copy-line">
          <Button variant="secondary" size="default" onClick={copy}>
            {copied ? S.copied : S.desktopLinkCopy}
          </Button>
          <span className="muted">{S.desktopLinkTextExpires(Math.floor(seconds / 60), String(seconds % 60).padStart(2, "0"))}</span>
        </div>
        <div className="muted">{S.desktopLinkPasteHint}</div>
      </div>
    </div>
  );
}

export function DesktopLinkOutgoing() {
  const { status, setStatus, problem, setProblem } = useLinkStatus();
  const [text, setText] = useState("");
  const [pairing, setPairing] = useState(false);

  if (REMOTE_ID) return <div className="setting-empty">{S.desktopLinkRemoteNote}</div>;

  const pair = () => {
    if (!text.trim() || pairing) return;
    setProblem(null);
    setPairing(true);
    void rpc
      .call("desktopLink.addRemote", { offer: text.trim() })
      .then((next) => {
        setStatus(next);
        setText("");
      })
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setPairing(false));
  };
  const remove = (id: string) => void rpc.call("desktopLink.removeRemote", { id }).then(setStatus).catch((error: Error) => setProblem(error.message));

  return (
    <div className="setting-mobile">
      <div className="setting-mobile-devices">
        <div className="setting-mobile-heading">{S.desktopLinkRemotes}</div>
        {status?.remotes.length === 0 && <div className="setting-empty">{S.desktopLinkNoRemotes}</div>}
        {status?.remotes.map((remote) => <RemoteRow key={remote.id} remote={remote} onRemove={() => remove(remote.id)} />)}
      </div>
      <div>
        <div className="setting-mobile-heading">{S.desktopLinkAdd}</div>
        <div className="link-add-line">
          <input className="input setting-text-input" spellCheck={false} aria-label={S.desktopLinkAddPlaceholder} placeholder={S.desktopLinkAddPlaceholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && pair()} />
          <Button variant="secondary" size="default" disabled={!text.trim() || pairing} onClick={pair}>
            {S.desktopLinkPair}
          </Button>
        </div>
        {problem && <div className="setting-problem link-add-problem">{problem}</div>}
      </div>
    </div>
  );
}

function RemoteRow({ remote, onRemove }: { remote: LinkRemote; onRemove: () => void }) {
  const [check, setCheck] = useState<LinkRemoteCheck | null>(null);
  useEffect(() => {
    let alive = true;
    const run = () => void rpc.call("desktopLink.checkRemote", { id: remote.id }).then((next) => alive && setCheck(next), () => undefined);
    run();
    const timer = setInterval(run, CHECK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [remote.id]);
  const open = () => {
    const native = window.agentNavNative?.openRemoteWindow;
    if (native) void native(remote.id);
    else window.open(`/?remote=${remote.id}`, "_blank");
  };
  const note = check === null ? S.desktopLinkChecking : !check.ok ? (check.error.startsWith("Could not reach") ? S.desktopLinkUnreachableNote : check.error) : check.sameVersion ? null : S.desktopLinkVersionDiffers(check.version);
  return (
    <div className="setting-subrow link-row">
      <span className="dot" data-state={check === null ? "pending" : check.ok ? "ok" : "off"} title={check === null ? S.desktopLinkChecking : check.ok ? S.desktopLinkReachable : S.desktopLinkUnreachable} />
      <div className="link-row-text">
        <span className="link-row-name">{check?.ok ? check.name : remote.name}</span>
        <span className="link-row-detail mono">{remote.address}</span>
        {note && <span className={check?.ok ? "setting-warning" : "link-row-detail"}>{note}</span>}
      </div>
      <Button variant="secondary" size="sm" disabled={!check?.ok} onClick={open}>
        {S.desktopLinkOpen}
      </Button>
      <Button size="sm" onClick={onRemove}>
        {S.desktopLinkRemove}
      </Button>
    </div>
  );
}
