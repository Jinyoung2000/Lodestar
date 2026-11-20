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

// 대화 속 파일 링크(a[data-file], code[data-file])가 가리키는 파일이 실제로 있는지 확인해 표시한다.
// 있으면 data-file 의 경로를 찾은 경로로 바꿔 눌렀을 때 바로 열리게 하고, 없으면 data-missing 을 달아 흐린 점선으로 그린다.
// 원래 경로는 data-file-orig 에 남겨 두어, 파일 목록이 바뀐 뒤 다시 확인할 때 처음 글에서 다시 푼다.

const existCache = new ExistCache();
// 한 번에 디스크에 확인하는 경로 수. 넘는 것은 있는 것으로 둔다(없다고 잘못 흐리느니 평소처럼 보이게).
const MAX_STAT = 60;

export const useFileRefVersion = () => {
  installInvalidation();
  return useSyncExternalStore(existCache.subscribe, existCache.getVersion);
};

// 파일을 만들었거나 지웠을 때 그 폴더의 존재 캐시를 버린다.
export const invalidateFileRefs = (workspaceId?: string) => existCache.invalidate(workspaceId);

let installed = false;
// 바깥에서 파일이 바뀌었거나(workspaceChanged) 에이전트의 도구가 끝났을 때(Bash 로 만든 파일까지) 캐시를 버린다.
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

// agentId 가 있으면, 작업 폴더에 없는 경로를 그 대화의 도구 호출이 만진 다른 폴더에서도 찾는다(web/fileRefOutside.ts).
export async function markFileRefs(root: HTMLElement, workspaceId: string, isStale: () => boolean, agentId?: string) {
  const files = await ensureFiles(workspaceId).catch(() => null);
  if (!files || isStale()) return;
  existCache.syncList(workspaceId, files);
  const index = fileIndex(files);
  const known = new Map(existCache.known(workspaceId));
  const items = collect(root, workspaceId);
  if (!items.length) return;

  // 1차는 힌트 없이, 2차는 1차에서 찾은 파일들을 힌트로 못 찾은 것만 다시 푼다.
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
  // 디스크 어디에도 없지만 대화가 GitHub 에서 읽은 저장소의 파일이면, 그 저장소의 로컬 클론(server/repoMirror.ts)에 있으면 그 파일로 열고
  // 없으면 누를 때 GitHub 주소를 연다(data-remote, web/AgentView.tsx). 누르면 그 저장소 클론도 시작한다(data-remote-repo).
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

// 못 찾은 링크마다 원격 저장소 파일인지 본다. 로컬 클론에 그 파일이 있으면 results 를 그 절대 경로로 바꾸고 null, 아니면 GitHub 주소를 돌려준다.
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

// 도구 입력을 읽을 최근 호출 수. 긴 대화를 처음부터 끝까지 훑지 않게.
const MAX_TOOL_INPUTS = 300;

// 작업 폴더에서 못 찾은 링크마다, 대화가 만진 바깥 폴더 기준 후보를 디스크에 물어 처음 있는 절대 경로를 돌려준다.
// 바깥 경로는 서버가 홈과 /tmp 아래 일반 파일만 읽어 주니(server/files.ts outsideReadable) 거절은 없는 것으로 본다.
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

// 최근 호출이 앞에 오는 도구 입력 글
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
    // 작업 폴더 안의 절대 경로는 상대 경로로 본다. 홈(~/)과 다른 폴더의 절대 경로는 확인하지 않는다.
    let raw = original.raw;
    if (workspaceDir && raw.startsWith(`${workspaceDir}/`)) raw = raw.slice(workspaceDir.length + 1);
    else if (raw.startsWith("/") || raw.startsWith("~")) continue;
    items.push({ el, original, raw });
  }
  return items;
}

// 후보 중 목록에 없는 것은 디스크에 물어 알아낸다(files.stat 묶음). 결과는 캐시에 남긴다.
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
          // 서버가 거절하거나 연결이 끊긴 경로는 캐시하지 않고 있는 것으로 본다
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

// 링크 바로 아래 코드 블록, 또는 링크가 코드 블록 첫 줄 주석일 때 그 코드. 문단에 서로 다른 파일 링크가 여럿이면 어느 파일 것인지 알 수 없어 붙이지 않는다.
function suggestedCodeFor(el: HTMLElement): string | null {
  const pre = el.closest("pre");
  if (pre) return codeWithoutPathHeader(pre.textContent ?? "", el.textContent ?? "");
  const block = el.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");
  const next = block?.nextElementSibling;
  if (!block || next?.tagName !== "PRE") return null;
  const origins = new Set([...block.querySelectorAll<HTMLElement>("[data-file]")].map((e) => normalizeRelative(JSON.parse(e.dataset.fileOrig ?? e.dataset.file ?? "{}").raw ?? "")));
  return origins.size === 1 ? withTrailingNewline(next.textContent ?? "") : null;
}
