import { paletteCommands } from "../web/commands";
import { BINDINGS } from "../web/keymap";
import { armEscapeTab, isTabFocusMode, noteKeyForTabFocus, tabShouldMoveFocus, toggleTabFocusMode } from "../web/tabFocus";

const same = (actual: unknown, wanted: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
};

same(tabShouldMoveFocus(), false, "기본은 들여쓰기");
armEscapeTab();
same(tabShouldMoveFocus(), true, "Esc 뒤 첫 Tab 은 포커스 이동");
same(tabShouldMoveFocus(), false, "한 번만 소모");
armEscapeTab();
noteKeyForTabFocus({ key: "Shift" });
same(tabShouldMoveFocus(), true, "수정키는 취소하지 않는다");
armEscapeTab();
noteKeyForTabFocus({ key: "a" });
same(tabShouldMoveFocus(), false, "다른 키가 오면 취소");
same(toggleTabFocusMode(), true, "토글 켜짐");
same([tabShouldMoveFocus(), tabShouldMoveFocus(), isTabFocusMode()], [true, true, true], "토글은 계속 유지");
same(toggleTabFocusMode(), false, "토글 꺼짐");
same(tabShouldMoveFocus(), false, "꺼지면 다시 들여쓰기");

const titles = paletteCommands().map((c) => c.title);
same(titles.includes("Source Control: Focus Commit Message"), true, "팔레트에 커밋 메시지 포커스 명령");
same(titles.includes("Editor: Toggle Tab Key Moves Focus"), true, "팔레트에 Tab 포커스 토글");
same(BINDINGS.find((b) => b.command === "toggleTabFocusMode")?.keys, ["Ctrl+Shift+KeyM"], "⌃⇧M");
console.log("tabfocus passed");
