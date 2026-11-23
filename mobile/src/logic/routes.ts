import { parseServerAddress, type PairingInfo } from "./pairing";

export type ConnectionRoute = { host: string; port: number; secure?: boolean };

export function routesFromAddress({ hosts, port, secure }: Pick<PairingInfo, "hosts" | "port" | "secure">): ConnectionRoute[] {
  return hosts.map((host) => ({ host, port, ...(secure && { secure }) }));
}

function formatHost(host: string) {
  return host.includes(":") ? `[${host}]` : host;
}

export function routeAddress(route: ConnectionRoute) {
  return `${route.secure ? "https" : "http"}://${formatHost(route.host)}:${route.port}`;
}

export function routeSocketUrl(route: ConnectionRoute) {
  const protocol = route.secure ? "wss" : "ws";
  const port = route.port === (route.secure ? 443 : 80) ? "" : `:${route.port}`;
  return `${protocol}://${formatHost(route.host)}${port}/mobile/ws`;
}

export function parseConnectionRoutes(input: string): ConnectionRoute[] | null {
  const lines = input.split("\n").map((line) => line.trim()).filter(Boolean);
  const routes = new Map<string, ConnectionRoute>();
  for (const line of lines) {
    const address = parseServerAddress(line.replace(/^http:\/\//i, "").replace(/\/$/, ""));
    if (!address || address.hosts.length !== 1) return null;
    const [route] = routesFromAddress(address);
    route.host = route.host.toLowerCase();
    routes.set(routeAddress(route), route);
  }
  return routes.size ? [...routes.values()] : null;
}

export function hasMixedRoutes(routes: ConnectionRoute[]) {
  return routes.some((route) => route.secure) && routes.some((route) => !route.secure);
}
