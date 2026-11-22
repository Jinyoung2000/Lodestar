import { useCallback, useEffect, useRef, useState } from "react";
import { relPathIn, resolveDefinitionTarget } from "../shared/prLsp";
import type { PrFile, PrLocalTarget } from "../shared/prTypes";
import { unsavedTextOf } from "./editorDocs";
import { languageIdFor, revealLocation, toTarget, uriToPath } from "./lsp";
import { acquirePrDoc, openPrDoc, type PrDoc, type PrDocMode } from "./prLspDocs";
import type { LspLocation } from "./prLspController";
import { CENTER, usePrActions, usePrView, usePrViewId } from "./prStore";
import { rpc } from "./rpc";
import { getState, setState as setAppState, useStore } from "./store";

export type PrOffReason = "no-workspace" | "fetch-needed" | "occupied" | "evicted" | "unreadable";

export type PrLspStatus =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; mode: PrDocMode; dir: string; exact: boolean; sha: string }
  | { kind: "off"; reason: PrOffReason; dir: string | null };

export type ReferenceHit = { location: LspLocation; line: number; text: string };
export type ReferenceGroup = { path: string; hits: ReferenceHit[] };
export type PrReferences = { title: string; groups: ReferenceGroup[] };

export type PrLsp = {
  status: PrLspStatus;
  doc: PrDoc | null;
  mismatched: boolean;
  reportMismatch: () => void;
  definition: (doc: PrDoc, pos: number) => Promise<LspLocation[]>;
  references: (doc: PrDoc, pos: number, word: string) => Promise<void>;
  navigate: (location: LspLocation, from: PrDoc) => void;
  refs: PrReferences | null;
  closeReferences: () => void;
  revealHere: React.MutableRefObject<((line: number, character: number) => void) | null>;
};

const NONE: PrLspStatus = { kind: "none" };

export function usePrLsp(file: PrFile | null, host: HTMLElement | null): PrLsp {
  const ref = usePrView((v) => v.ref);
  const headSha = usePrView((v) => v.detail?.headSha ?? null);
  const headRef = usePrView((v) => v.detail?.headRef ?? null);
  const files = usePrView((v) => v.files);
  const actions = usePrActions();
  const viewId = usePrViewId();
  const workspaceKey = useStore((s) => s.workspaces.map((w) => w.id).join(","));
  const visible = useVisible(host);
  const [target, setTarget] = useState<PrLocalTarget | null>(null);
  const [state, setState] = useState<{ doc: PrDoc | null; status: PrLspStatus }>({ doc: null, status: NONE });
  const [mismatched, setMismatched] = useState(false);
  const [refs, setRefs] = useState<PrReferences | null>(null);
  const filesRef = useRef<PrFile[] | null>(files);
  filesRef.current = files;
  const shaRef = useRef(headSha);
  shaRef.current = headSha;
  const fileRef = useRef(file);
  fileRef.current = file;
  const refKey = ref ? `${ref.repo}#${ref.number}` : "";
  const extras = useRef(new Map<string, () => void>());
  const revealHere = useRef<((line: number, character: number) => void) | null>(null);

  useEffect(() => {
    if (!visible || !ref || !headSha || !headRef) return;
    let cancelled = false;
    void rpc
      .call("pr.local", { repo: ref.repo, number: ref.number, headRef, headSha })
      .then((next) => !cancelled && setTarget(next))
      .catch(() => !cancelled && setTarget({ kind: "no-workspace" }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refKey, headSha, headRef, workspaceKey]);

  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = target ? `${target.kind}\0${"workspaceId" in target ? target.workspaceId : ""}` : "";

  useEffect(() => {
    setMismatched(false);
    setRefs(null);
    const t = targetRef.current;
    const current = fileRef.current;
    const sha = shaRef.current;
    if (!visible || !current || !sha || !languageIdFor(current.path) || current.status === "removed" || !current.patch) {
      setState({ doc: null, status: NONE });
      return;
    }
    if (!t) {
      setState({ doc: null, status: { kind: "loading" } });
      return;
    }
    if (t.kind === "no-workspace") {
      setState({ doc: null, status: { kind: "off", reason: "no-workspace", dir: null } });
      return;
    }
    if (t.kind === "fetch-needed") {
      setState({ doc: null, status: { kind: "off", reason: "fetch-needed", dir: t.dir } });
      return;
    }
    let cancelled = false;
    let release = () => {};
    let unsubscribe = () => {};
    const path = current.path;
    const opened = extras.current;
    const mode: PrDocMode = t.kind === "commit" ? "commit" : "checked-out";
    setState({ doc: null, status: { kind: "loading" } });
    void (async () => {
      const text = mode === "commit" ? await readAt(t.workspaceId, sha, path) : (unsavedTextOf(t.workspaceId, path) ?? (await readDisk(t.workspaceId, path)));
      if (cancelled) return;
      if (text === null) {
        setState({ doc: null, status: { kind: "off", reason: "unreadable", dir: t.dir } });
        return;
      }
      const result = acquirePrDoc({ workspaceId: t.workspaceId, path, mode, text });
      if (cancelled) {
        result.release();
        return;
      }
      if (!result.doc) {
        setState({ doc: null, status: result.reason === "occupied" ? { kind: "off", reason: "occupied", dir: t.dir } : NONE });
        return;
      }
      const doc = result.doc;
      release = result.release;
      if (mode === "commit") await openSiblings(t.workspaceId, sha, path, filesRef.current ?? [], opened, () => cancelled);
      if (cancelled) {
        release();
        for (const free of opened.values()) free();
        opened.clear();
        return;
      }
      const onEvicted = () => setState({ doc: null, status: { kind: "off", reason: "evicted", dir: t.dir } });
      doc.onEvicted.add(onEvicted);
      unsubscribe = () => doc.onEvicted.delete(onEvicted);
      setState({ doc, status: { kind: "ready", mode, dir: t.dir, exact: t.kind === "commit" || t.exact, sha } });
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      release();
      for (const free of opened.values()) free();
      opened.clear();
    };
  }, [visible, file?.path, file?.status, file?.patch, targetKey, headSha]);

  const dirOf = (workspaceId: string) => getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";

  const definition = useCallback(async (doc: PrDoc, pos: number) => {
    doc.plugin.client.sync();
    return asLocations(await doc.plugin.client.request("textDocument/definition", { textDocument: { uri: doc.uri }, position: doc.plugin.toPosition(pos, doc.view.state.doc) }));
  }, []);

  const navigate = useCallback(
    (location: LspLocation, from: PrDoc) => {
      const rel = relPathIn(dirOf(from.workspaceId), uriToPath(location.uri));
      const place = resolveDefinitionTarget(filesRef.current ?? [], rel, location.range.start.line);
      if (place.kind === "local") {
        if (viewId === CENTER) setAppState({ centerView: "sessions" });
        revealLocation(from.workspaceId, location);
        return;
      }
      if (place.path === fileRef.current?.path) revealHere.current?.(place.line, location.range.start.character);
      else {
        setPendingReveal({ key: refKey, path: place.path, line: place.line, character: location.range.start.character });
        actions.selectFile(place.path);
      }
    },
    [actions, refKey, viewId],
  );

  const references = useCallback(
    async (doc: PrDoc, pos: number, word: string) => {
      doc.plugin.client.sync();
      const result = await doc.plugin.client.request("textDocument/references", { textDocument: { uri: doc.uri }, position: doc.plugin.toPosition(pos, doc.view.state.doc), context: { includeDeclaration: true } });
      const locations = asLocations(result);
      const dir = dirOf(doc.workspaceId);
      const byPath = new Map<string, LspLocation[]>();
      for (const location of locations) {
        const absolute = uriToPath(location.uri);
        const key = relPathIn(dir, absolute) ?? absolute;
        byPath.set(key, [...(byPath.get(key) ?? []), location]);
      }
      const groups = await Promise.all(
        [...byPath].map(async ([path, list]) => {
          const lines = await linesOf(doc, path);
          return { path, hits: list.map((location) => ({ location, line: location.range.start.line + 1, text: (lines[location.range.start.line] ?? "").trim() })) };
        }),
      );
      setRefs({ title: `${word || "Symbol"} - ${locations.length} ${locations.length === 1 ? "reference" : "references"}`, groups });
    },
    [],
  );

  return {
    status: state.status,
    doc: state.doc,
    mismatched,
    reportMismatch: useCallback(() => setMismatched(true), []),
    definition,
    references,
    navigate,
    refs,
    closeReferences: useCallback(() => setRefs(null), []),
    revealHere,
  };
}

const MAX_SIBLINGS = 20;

async function openSiblings(workspaceId: string, sha: string, except: string, files: PrFile[], opened: Map<string, () => void>, cancelled: () => boolean) {
  const siblings = files.filter((f) => f.path !== except && f.status !== "removed" && languageIdFor(f.path) !== null && f.patch).slice(0, MAX_SIBLINGS);
  await Promise.all(
    siblings.map(async (f) => {
      const text = await readAt(workspaceId, sha, f.path);
      if (text === null || cancelled()) return;
      const result = acquirePrDoc({ workspaceId, path: f.path, mode: "commit", text });
      if (result.doc) opened.set(f.path, result.release);
    }),
  );
}

async function readAt(workspaceId: string, sha: string, path: string): Promise<string | null> {
  try {
    return (await rpc.call("pr.fileAt", { workspaceId, sha, path })).text;
  } catch {
    return null;
  }
}

async function readDisk(workspaceId: string, path: string): Promise<string | null> {
  try {
    return (await rpc.call("files.read", { workspaceId, path })).text ?? null;
  } catch {
    return null;
  }
}

async function linesOf(doc: PrDoc, path: string): Promise<string[]> {
  const open = openPrDoc(doc.workspaceId, path);
  if (open) return open.view.state.doc.toString().split("\n");
  const target = path.startsWith("/") ? toTarget(path, doc.workspaceId) : { workspaceId: doc.workspaceId, path };
  return ((await readDisk(target.workspaceId, target.path)) ?? "").split("\n");
}

type RawLocation = { uri: string; range: LspLocation["range"] } | { targetUri: string; targetSelectionRange: LspLocation["range"]; targetRange?: LspLocation["range"] };

function asLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const list = (Array.isArray(result) ? result : [result]) as RawLocation[];
  return list.map((item) => ("targetUri" in item ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange! } : item));
}

type PendingReveal = { key: string; path: string; line: number; character: number };
let pending: PendingReveal | null = null;

export function setPendingReveal(next: PendingReveal) {
  pending = next;
}

export function takePendingReveal(key: string, path: string): PendingReveal | null {
  if (!pending || pending.key !== key || pending.path !== path) return null;
  const taken = pending;
  pending = null;
  return taken;
}

function useVisible(host: HTMLElement | null) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!host) {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
    observer.observe(host);
    return () => {
      observer.disconnect();
      setVisible(false);
    };
  }, [host]);
  return visible;
}
