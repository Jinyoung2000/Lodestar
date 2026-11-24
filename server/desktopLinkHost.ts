import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { version as APP_VERSION } from "../package.json";
import { cleanLinkName, decodeLinkOffer, encodeLinkOffer, keyFingerprint, type DesktopLinkStatus, type LinkHttpPath } from "../shared/desktopLink";
import { DesktopLinkClient, DesktopLinkServer, LinkPeers, LinkRemotes, loadLinkIdentity, openLink, peerView, remoteView } from "./desktopLink";
import { mediaOriginAllowed } from "./mediaHttp";
import { lanHosts, PairingCodes } from "./mobileAccess";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type DesktopLinkDeps = { home: string; daemonPort: number; token: string; enabled: () => boolean; log: (line: string) => void };
export type RemoteHttpGuard = { token: string; origins: ReadonlySet<string> };

const OFF_ERROR = "Desktop link is off. Turn it on in Settings first";

function sameToken(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDesktopLink(deps: DesktopLinkDeps) {
  const port = Number(process.env.AGENT_NAV_LINK_PORT ?? deps.daemonPort + 2);
  const bind = process.env.AGENT_NAV_LINK_BIND ?? "0.0.0.0";
  const name = cleanLinkName(hostname().replace(/\.local$/, "")) || "Mac";
  const identity = loadLinkIdentity(join(deps.home, "desktop-link.json"));
  const peers = new LinkPeers(join(deps.home, "desktop-link-peers.json"));
  const remotes = new LinkRemotes(join(deps.home, "desktop-link-remotes.json"));
  const pairing = new PairingCodes();
  const server = new DesktopLinkServer({ identity, peers, pairing, daemon: { port: deps.daemonPort, token: deps.token }, name, version: APP_VERSION, log: deps.log });
  const client = new DesktopLinkClient({ identity, remotes, log: deps.log });

  const status = (): DesktopLinkStatus => ({
    enabled: deps.enabled(),
    listening: server.listening,
    port: server.listening ? server.port : port,
    hosts: lanHosts(),
    error: server.error,
    name,
    fingerprint: keyFingerprint(identity.key),
    peers: peers.list().map((peer) => peerView(peer, server.online(peer.id))),
    remotes: remotes.list().map(remoteView),
  });

  async function apply() {
    if (deps.enabled()) {
      if (!server.listening) await server.start(port, bind).catch((error) => deps.log(`[link] could not listen: ${error instanceof Error ? error.message : String(error)}`));
    } else if (server.listening) await server.stop();
  }

  const handlers: HandlersFor<MethodsIn<"desktopLink">> = {
    "desktopLink.status": () => status(),
    "desktopLink.pairingOffer": () => {
      if (!server.listening) throw new Error(OFF_ERROR);
      const hosts = lanHosts().map((host) => host.address);
      if (hosts.length === 0) throw new Error("This Mac has no network address another Mac could reach");
      const issued = pairing.issue();
      return { text: encodeLinkOffer({ name, hosts, port: server.port, key: identity.key, code: issued.code }), expiresAt: issued.expiresAt };
    },
    "desktopLink.revokePeer": ({ id }) => {
      if (!peers.remove(String(id))) throw new Error("Unknown Mac");
      server.closePeer(String(id));
      return status();
    },
    "desktopLink.addRemote": async ({ offer }) => {
      const parsed = decodeLinkOffer(offer);
      if (!parsed) throw new Error("That is not a Lodestar pairing text. Copy it again from the other Mac.");
      if (parsed.key === identity.key) throw new Error("That pairing text is from this Mac. Create it on the Mac you want to open.");
      const target = { hosts: parsed.hosts, port: parsed.port, publicKey: parsed.key };
      const opened = await openLink(identity, target, { v: 1, kind: "pair", code: parsed.code, name });
      opened.stream.close();
      remotes.add({ name: opened.welcome.ok ? opened.welcome.name : parsed.name, hosts: parsed.hosts, port: parsed.port, publicKey: parsed.key, lastHost: opened.host });
      return status();
    },
    "desktopLink.removeRemote": ({ id }) => {
      if (!remotes.remove(String(id))) throw new Error("Unknown Mac");
      return status();
    },
    "desktopLink.checkRemote": async ({ id }) => {
      try {
        const answer = await client.check(String(id));
        return { ok: true, name: answer.name, version: answer.version, sameVersion: answer.version === APP_VERSION };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  async function proxyHttp(req: IncomingMessage, res: ServerResponse, url: URL, remoteId: string, path: LinkHttpPath, guard: RemoteHttpGuard) {
    const refuse = (status: number, text: string) => void res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
    if (path === "/attachments") {
      if (req.method !== "POST") return refuse(405, "method not allowed");
      if (!guard.origins.has(req.headers.origin ?? "") || !sameToken(req.headers["x-agent-nav-token"], guard.token)) return refuse(403, "forbidden");
    } else {
      if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method not allowed");
      if (!mediaOriginAllowed(req.headers, guard.origins)) return refuse(403, "forbidden");
    }
    try {
      await client.proxyHttp(req, res, remoteId, path, url.search.slice(1));
    } catch (error) {
      deps.log(`[link] ${path} to ${remoteId} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) refuse(502, "the other Mac could not be reached");
      else res.end();
    }
  }

  return { handlers, apply, client, proxyHttp, stop: () => server.stop() };
}
