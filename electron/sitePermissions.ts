import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { dataHome } from "./dataHome";
import { categoriesFor, isAlwaysAllowed, PERMISSION_CATEGORIES, PermissionStore, permissionOrigin, type PermissionCategory, type PermissionDecision } from "../web/browserPermissions";

export const permissions = new PermissionStore();
const PERMISSIONS_FILE = join(dataHome(), "browser-permissions.json");
const PERMISSION_ASK_MS = 30_000;
const permissionAsks = new Map<string, (answer: PermissionDecision | null) => void>();

export function loadPermissions() {
  try {
    permissions.hydrate(JSON.parse(readFileSync(PERMISSIONS_FILE, "utf8")));
  } catch {
  }
}

function savePermissions() {
  try {
    mkdirSync(join(PERMISSIONS_FILE, ".."), { recursive: true });
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(permissions.serialize(), null, 2));
  } catch (error) {
    console.error("[permissions] save failed", error);
  }
}

export type SitePermissionDeps = {
  fromOurPage: (event: Electron.IpcMainInvokeEvent) => boolean;
  hostContents: (requester: Electron.WebContents | null) => Electron.WebContents | null;
};

export function registerSitePermissions(deps: SitePermissionDeps) {
  function askPermission(origin: string, category: PermissionCategory, requester: Electron.WebContents | null): Promise<PermissionDecision | null> {
    return new Promise((resolve) => {
      const host = deps.hostContents(requester);
      if (!host) return resolve(null);
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => finish(null), PERMISSION_ASK_MS);
      const finish = (answer: PermissionDecision | null) => {
        clearTimeout(timer);
        permissionAsks.delete(requestId);
        resolve(answer);
      };
      permissionAsks.set(requestId, finish);
      host.send("agent-nav:browser-permission", { requestId, origin, category });
    });
  }

  async function resolvePermission(permission: string, url: string, mediaTypes: readonly string[] | undefined, requester: Electron.WebContents | null): Promise<boolean> {
    if (isAlwaysAllowed(permission)) return true;
    const origin = permissionOrigin(url);
    const categories = categoriesFor(permission, mediaTypes);
    let verdict = permissions.decide(origin, categories);
    if (verdict === "ask") {
      for (const category of categories) {
        if (permissions.getDecision(origin, category) || permissions.isAllowed(origin, category)) continue;
        const answer = await askPermission(origin, category, requester);
        if (answer) permissions.set(origin, category, answer);
        if (answer === "deny") break;
      }
      savePermissions();
      verdict = permissions.decide(origin, categories);
    }
    return verdict === "allow";
  }

  ipcMain.handle("agent-nav:browser-permission-answer", (event, requestId: unknown, answer: unknown) => {
    if (!deps.fromOurPage(event) || typeof requestId !== "string") throw new Error("permission refused");
    permissionAsks.get(requestId)?.(answer === "allow" || answer === "deny" ? answer : null);
  });

  ipcMain.handle("agent-nav:browser-permissions-get", (event, url: unknown) => {
    if (!deps.fromOurPage(event)) throw new Error("permission refused");
    const origin = permissionOrigin(String(url));
    return { origin, items: PERMISSION_CATEGORIES.map((category) => ({ category, decision: permissions.getDecision(origin, category) ?? null, state: permissions.stateOf(origin, category) })) };
  });

  ipcMain.handle("agent-nav:browser-permissions-set", (event, url: unknown, changes: unknown) => {
    if (!deps.fromOurPage(event) || !Array.isArray(changes)) throw new Error("permission refused");
    const origin = permissionOrigin(String(url));
    for (const change of changes as { category?: unknown; state?: unknown }[]) {
      if (!(PERMISSION_CATEGORIES as readonly string[]).includes(String(change.category))) continue;
      permissions.set(origin, change.category as PermissionCategory, change.state === "allow" || change.state === "deny" ? change.state : null);
    }
    savePermissions();
  });

  return { resolvePermission };
}
