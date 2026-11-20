import type { Extension } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { rangeHighlightExtension } from "./editorRangeHighlight";

// 상태 표시줄(web/EditorStatus.tsx)이 읽는 작은 외부 저장소. 모든 에디터 보기가 트랜잭션을 처리할 때마다 버전을 올려 알리고,
// 상태 표시줄은 활성 에디터의 EditorView 상태를 직접 읽는다(선택, 줄끝, 들여쓰기가 모두 상태에 있다).
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

export function subscribeEditorStatus(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const editorStatusVersion = () => version;

// 에디터가 업데이트를 처리하는 도중에 React 가 같은 보기의 상태를 읽지 않도록 마이크로태스크로 미룬다
function notify() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    version++;
    for (const listener of listeners) listener();
  });
}

const notifier = ViewPlugin.fromClass(
  class {
    constructor() {
      notify();
    }
    update(update: ViewUpdate) {
      if (update.transactions.length) notify();
    }
    destroy() {
      notify();
    }
  },
);

// editorBase() 의 정적 묶음에 한 줄로 들어간다: 상태 표시줄 알림과 줄 범위 강조 필드. 줄 바꿈 덮어쓰기 필드는 wrapExtension 이 같이 든다.
export function editorStatusExtensions(): Extension {
  return [notifier, rangeHighlightExtension];
}
