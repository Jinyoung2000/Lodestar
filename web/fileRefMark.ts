import { useSyncExternalStore } from "react";
import { ExistCache } from "./fileExistCache";
import { outsideCandidates, remoteFile } from "./fileRefOutside";
import { fileIndex, normalizeRelative, resolveFileRef, type Resolution } from "./fileRefResolve";
import type { FileRef } from "./fileRefParse";
import { codeWithoutPathHeader, rememberSuggestedCode, withTrailingNewline } from "./missingFileCode";
import { MF } from "./missingFileStrings";
import { rpc } from "./rpc";
import { ensureFiles, getState } from "./store";
import { WORKSPACE_CHANGED_EVENT } from "./workspaceEvents";

const existCache = new ExistCache();
const MAX_STAT = 60;

export const useFileRefVersion = () => {
  installInvalidation();
  return useSyncExternalStore(existCache.subscribe, existCache.getVersion);
};

export const invalidateFileRefs = (workspaceId?: string) => existCache.invalidate(workspaceId);

let installed = false;
function installInvalidation() {
  if (installed) return;
  installed = true;
  window.addEventListener(WORKSPACE_CHANGED_EVENT, (event) => {
    for (const id of (event as CustomEvent<{ workspaceIds: string[] }>).detail.workspaceIds) existCache.invalidate(id);
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  rpc.onEvent((event) => {
    if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => existCache.invalidate(), 400);
  });
}

type Item = { el: HTMLElement; original: FileRef; raw: string };

export async function markFileRefs(root: HTMLElement, workspaceId: string, isStale: () => boolean, agentId?: string) {
  const files = await ensureFiles(workspaceId).catch(() => null);
  if (!files || isStale()) return;
  existCache.syncList(workspaceId, files);
  const index = fileIndex(files);
  const known = new Map(existCache.known(workspaceId));
  const items = collect(root, workspaceId);
  if (!items.length) return;

  const first = await settle(items, [], index, known, workspaceId);
  if (isStale()) return;
  const hints = first.flatMap((r) => (r.kind === "found" ? [r.path] : []));
  const results = [...first];
  if (hints.length) {
    const retry = items.map((_, i) => i).filter((i) => first[i].kind === "missing" || first[i].kind === "ambiguous");
    if (retry.length) {
      const second = await settle(retry.map((i) => items[i]), hints, index, known, workspaceId);
      if (isStale()) return;
      retry.forEach((i, n) => {
        results[i] = second[n];
      });
    }
  }
  if (agentId) {
    const outside = await settleOutside(items, results, agentId, known, workspaceId);
    if (isStale()) return;
    outside.forEach((path, i) => {
      if (path) results[i] = { kind: "found", path };
    });
  }
  const remotes = await settleRemote(items, results, agentId, known, workspaceId);
  if (isStale()) return;
  items.forEach((item, i) => {
    if (!item.el.isConnected) return;
    const result = results[i];
    const remote = remotes[i];
    if (remote && result.kind === "missing") {
      apply(item, { kind: "found", path: result.path }, workspaceId);
      item.el.dataset.remote = remote.url;
      item.el.dataset.remoteRepo = remote.repo;
      item.el.title = remote.url;
      return;
    }
    if (item.el.dataset.remote) {
      if (item.el.title === item.el.dataset.remote) item.el.removeAttribute("title");
      delete item.el.dataset.remote;
      delete item.el.dataset.remoteRepo;
    }
    apply(item, result, workspaceId);
  });
}

async function settleRemote(items: Item[], results: Resolution[], agentId: string | undefined, known: Map<string, boolean>, workspaceId: string) {
  const out: ({ repo: string; url: string } | null)[] = items.map(() => null);
  const inputs = agentId ? toolInputs(agentId) : [];
  if (!inputs.length) return out;
  const missing = items.map((_, i) => i).filter((i) => results[i].kind === "missing");
  for (const i of missing) out[i] = remoteFile(normalizeRelative(items[i].raw), inputs, items[i].original.line);
  const repos = [...new Set(out.flatMap((r) => (r ? [r.repo] : [])))];
  if (!repos.length) return out;
  const dirs = new Map<string, string | null>();
  await Promise.all(
    repos.map((repo) =>
      rpc
        .call("repos.mirrorDir", { repo })
        .then(({ dir }) => dirs.set(repo, dir))
        .catch(() => dirs.set(repo, null)),
    ),
  );
  await Promise.all(
    missing.map(async (i) => {
      const dir = out[i] ? dirs.get(out[i].repo) : null;
      if (!dir) return;
      const path = `${dir}/${normalizeRelative(items[i].raw)}`;
      if (!known.has(path)) {
        const exists = await rpc
          .call("files.stat", { workspaceId, path })
          .then(({ mtimeMs }) => mtimeMs !== null)
          .catch(() => false);
        known.set(path, exists);
        existCache.set(workspaceId, path, exists);
      }
      if (known.get(path)) {
        results[i] = { kind: "found", path };
        out[i] = null;
      }
    }),
  );
  return out;
}

const MAX_TOOL_INPUTS = 300;

async function settleOutside(items: Item[], results: Resolution[], agentId: string, known: Map<string, boolean>, workspaceId: string): Promise<(string | null)[]> {
  const found: (string | null)[] = items.map(() => null);
  const missing = items.map((_, i) => i).filter((i) => results[i].kind === "missing");
  if (!missing.length) return found;
  const inputs = toolInputs(agentId);
  if (!inputs.length) return found;
  const workspaceDir = getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  const candidates = new Map(missing.map((i) => [i, outsideCandidates(normalizeRelative(items[i].raw), inputs, workspaceDir)] as const));
  const need = [...new Set([...candidates.values()].flat())].filter((p) => !known.has(p)).slice(0, MAX_STAT);
  await Promise.all(
    need.map((path) =>
      rpc
        .call("files.stat", { workspaceId, path })
        .then(({ mtimeMs }) => mtimeMs !== null)
        .catch(() => false)
        .then((exists) => {
          known.set(path, exists);
          existCache.set(workspaceId, path, exists);
        }),
    ),
  );
  for (const [i, list] of candidates) found[i] = list.find((p) => known.get(p) === true) ?? null;
  return found;
}

function toolInputs(agentId: string): string[] {
  const items = getState().timelines[agentId] ?? [];
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < MAX_TOOL_INPUTS; i -= 1) {
    const item = items[i];
    if (item.kind === "tool") out.push(JSON.stringify(item.input));
  }
  return out;
}

function collect(root: HTMLElement, workspaceId: string): Item[] {
  const workspaceDir = getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  const items: Item[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-file]")) {
    const text = el.dataset.fileOrig ?? el.dataset.file;
    if (!text) continue;
    let original: FileRef;
    try {
      original = JSON.parse(text) as FileRef;
    } catch {
      continue;
    }
    el.dataset.fileOrig = text;
    let raw = original.raw;
    if (workspaceDir && raw.startsWith(`${workspaceDir}/`)) raw = raw.slice(workspaceDir.length + 1);
    else if (raw.startsWith("/") || raw.startsWith("~")) continue;
    items.push({ el, original, raw });
  }
  return items;
}

async function settle(items: Item[], hints: string[], index: ReturnType<typeof fileIndex>, known: Map<string, boolean>, workspaceId: string): Promise<Resolution[]> {
  let results = items.map((item) => resolveFileRef(index, item.raw, hints, known));
  const need = [...new Set(results.flatMap((r) => (r.kind === "pending" ? r.check : [])))].filter((p) => !known.has(p));
  if (need.length) {
    await Promise.all(
      need.slice(0, MAX_STAT).map((path) =>
        rpc
          .call("files.stat", { workspaceId, path })
          .then(({ mtimeMs }) => {
            known.set(path, mtimeMs !== null);
            existCache.set(workspaceId, path, mtimeMs !== null);
          })
          .catch(() => known.set(path, true)),
      ),
    );
    for (const path of need.slice(MAX_STAT)) known.set(path, true);
    results = items.map((item) => resolveFileRef(index, item.raw, hints, known));
  }
  return results;
}

function apply(item: Item, result: Resolution, workspaceId: string) {
  const { el, original } = item;
  if (result.kind === "found" || result.kind === "missing") el.dataset.file = JSON.stringify({ ...original, raw: result.path });
  else if (el.dataset.fileOrig) el.dataset.file = el.dataset.fileOrig;
  if (result.kind === "missing") {
    el.dataset.missing = "true";
    el.title = MF.linkTip;
    const code = suggestedCodeFor(el);
    if (code !== null) rememberSuggestedCode(workspaceId, result.path, code);
    return;
  }
  if (el.dataset.missing) {
    delete el.dataset.missing;
    if (el.title === MF.linkTip) el.removeAttribute("title");
  }
}

function suggestedCodeFor(el: HTMLElement): string | null {
  const pre = el.closest("pre");
  if (pre) return codeWithoutPathHeader(pre.textContent ?? "", el.textContent ?? "");
  const block = el.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");
  const next = block?.nextElementSibling;
  if (!block || next?.tagName !== "PRE") return null;
  const origins = new Set([...block.querySelectorAll<HTMLElement>("[data-file]")].map((e) => normalizeRelative(JSON.parse(e.dataset.fileOrig ?? e.dataset.file ?? "{}").raw ?? "")));
  return origins.size === 1 ? withTrailingNewline(next.textContent ?? "") : null;
}
