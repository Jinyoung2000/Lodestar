import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { unsavedTextOf } from "./editorDocs";
import { commitAtCursor, statusTitle, whoWhen, type BlameData } from "./gitBlameModel";
import { rpc } from "./rpc";
import { onWorkspaceChanged } from "./workspaceEvents";

// 에디터 current line blame. 커서 줄의 `작성자, 상대시간` 은 상태 표시줄(web/EditorStatus.tsx)에만 보인다. 같은 내용이라 줄 끝 주석은 띄우지 않는다.
// blame 은 데몬(git.blame)이 파일 전체를 한 번 돌려 준 것을 쓰고, 다시 읽는 때는 열 때, 폴더가 바뀔 때(커밋, 브랜치 이동, 저장), 창이 포커스를 받을 때, 문서를 고치고 잠깐 멈췄을 때다.
// 저장 안 한 편집이 있으면 그 버퍼를 같이 보내 줄 번호가 맞는 blame 을 받는다(고친 줄은 커밋 안 된 줄로 나온다). 일반 파일 탭 에디터에만 붙인다(diff, PR 보기는 이 확장을 쓰지 않는다).

// 고친 문서의 blame 을 다시 읽기까지 기다리는 시간
const SETTLE_MS = 250;
// 폴더 변경 알림이 몰릴 때 한 번으로 모으는 시간
const REFRESH_MS = 300;

export function gitBlame(workspaceId: string, path: string): Extension {
  return [blameField, ViewPlugin.define((view) => new BlameDriver(view, workspaceId, path))];
}

// 커서 줄의 blame 을 상태 표시줄이 읽는다. 문서가 blame 과 다르면(고치는 중) null. 확장이 없는 에디터도 null.
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

// 읽기와 다시 읽기를 맡는 에디터당 하나의 객체
class BlameDriver {
  private live = true;
  private loading = false;
  private again = false;
  // 마지막 응답이 null(저장소가 아니거나 HEAD 에 없는 파일)이면 고칠 때마다 다시 묻지 않는다. 폴더가 바뀌거나 창이 포커스를 받으면 다시 본다.
  private tracked = true;
  // 보이지 않는 탭(display none)은 폴더가 바뀌어도 읽지 않고 표시만 해 두었다가 커서가 움직일 때 읽는다
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
    // 읽는 동안 또 요청이 오면 끝난 뒤 한 번 더 읽는다
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.stale = false;
    const { state } = this.view;
    const doc = state.doc;
    // 저장 안 한 편집이 있을 때만 버퍼를 보낸다. 줄끝은 이 문서의 것으로 이어 붙여야 git 이 모든 줄을 다른 줄로 보지 않는다(CRLF 파일).
    const unsaved = unsavedTextOf(this.workspaceId, this.path) !== null;
    try {
      const { blame } = await rpc.call("git.blame", { workspaceId: this.workspaceId, path: this.path, ...(unsaved ? { text: doc.sliceString(0, doc.length, state.lineBreak) } : {}) });
      if (!this.live) return;
      this.tracked = blame !== null;
      this.view.dispatch({ effects: setBlame.of(blame ? { doc, blame } : null) });
    } catch {
      // 읽지 못하면 표시하지 않는다(오류 토스트 없음). 다음 변경 때 다시 읽는다.
    } finally {
      this.loading = false;
      if (this.again && this.live) {
        this.again = false;
        void this.load();
      }
    }
  }
}
