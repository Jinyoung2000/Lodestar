import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { unsavedTextOf } from "./editorDocs";
import { commitAtCursor, statusTitle, whoWhen, type BlameData } from "./gitBlameModel";
import { rpc } from "./rpc";
import { onWorkspaceChanged } from "./workspaceEvents";

const SETTLE_MS = 250;
const REFRESH_MS = 300;

export function gitBlame(workspaceId: string, path: string): Extension {
  return [blameField, ViewPlugin.define((view) => new BlameDriver(view, workspaceId, path))];
}

export function blameStatus(state: EditorState, now = Date.now()): { text: string; title: string } | null {
  const commit = commitAtCursor(state.field(blameField, false) ?? null, state);
  return commit ? { text: whoWhen(commit, now), title: statusTitle(commit) } : null;
}

const setBlame = StateEffect.define<BlameData | null>();

const blameField = StateField.define<BlameData | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBlame)) return effect.value;
    return value;
  },
});

class BlameDriver {
  private live = true;
  private loading = false;
  private again = false;
  private tracked = true;
  private stale = false;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offWorkspace: () => void;
  private readonly refresh = () => {
    if (this.view.dom.offsetParent === null) this.stale = true;
    else this.loadLater(REFRESH_MS);
  };

  constructor(
    private readonly view: EditorView,
    private readonly workspaceId: string,
    private readonly path: string,
  ) {
    this.offWorkspace = onWorkspaceChanged(workspaceId, this.refresh);
    window.addEventListener("focus", this.refresh);
    void this.load();
  }

  update(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return;
    if (this.stale || (update.docChanged && this.tracked)) this.loadLater(SETTLE_MS);
  }

  destroy() {
    this.live = false;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.offWorkspace();
    window.removeEventListener("focus", this.refresh);
  }

  private loadLater(ms: number) {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      void this.load();
    }, ms);
  }

  private async load() {
    if (!this.live) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.stale = false;
    const { state } = this.view;
    const doc = state.doc;
    const unsaved = unsavedTextOf(this.workspaceId, this.path) !== null;
    try {
      const { blame } = await rpc.call("git.blame", { workspaceId: this.workspaceId, path: this.path, ...(unsaved ? { text: doc.sliceString(0, doc.length, state.lineBreak) } : {}) });
      if (!this.live) return;
      this.tracked = blame !== null;
      this.view.dispatch({ effects: setBlame.of(blame ? { doc, blame } : null) });
    } catch {
    } finally {
      this.loading = false;
      if (this.again && this.live) {
        this.again = false;
        void this.load();
      }
    }
  }
}
