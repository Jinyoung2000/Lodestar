import { pendingToolRequest } from "../shared/interactive";
import { paletteCommands } from "../web/commands";
import { BINDINGS, INTERCEPT_STROKES, stepKey, strokeOf, type KeyContext } from "../web/keymap";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const perm = (id: string, toolName: string, status: "pending" | "allowed" | "denied" = "pending") => ({ id, kind: "permission", toolName, status });
check("no timeline, no request", pendingToolRequest(undefined) === null);
check("a pending Bash request is the target", pendingToolRequest([{ id: "u1", kind: "user" }, perm("p1", "Bash")])?.id === "p1");
check("answered requests are skipped", pendingToolRequest([perm("p1", "Bash", "allowed"), perm("p2", "Write")])?.id === "p2");
check("the card shows the first pending request, so that one is the target", pendingToolRequest([perm("p1", "Write"), perm("p2", "Bash")])?.id === "p1");
check("a pending question is not a shortcut target", pendingToolRequest([perm("q1", "AskUserQuestion")]) === null);
check("a pending plan is not a shortcut target", pendingToolRequest([perm("e1", "ExitPlanMode")]) === null);
check("a question in front of a tool request blocks the shortcut (the card on screen is the question)", pendingToolRequest([perm("q1", "AskUserQuestion"), perm("p1", "Bash")]) === null);

const key = (code: string, mods: { meta?: boolean; alt?: boolean; shift?: boolean; ctrl?: boolean } = {}) => strokeOf({ code, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl })!;
const verdict = (stroke: string, ctx: KeyContext) => {
  const out = stepKey(null, stroke, ctx, 0);
  return out.kind === "run" ? out.command : out.kind;
};
const base: KeyContext = { inTerminal: false, inEditor: false };
const composer: KeyContext = { ...base, inComposer: true, inChat: true, approvalPending: true };

check("strokes", key("Enter", { meta: true }) === "Meta+Enter" && key("Enter", { meta: true, alt: true }) === "Alt+Meta+Enter");
check("⌘Enter allows once while a card is pending (from the composer)", verdict("Meta+Enter", composer) === "acceptTool");
check("⌥⌘Enter skips while a card is pending", verdict("Alt+Meta+Enter", composer) === "skipTool");
check("they work from outside the composer too (focus on the sidebar)", verdict("Meta+Enter", { ...base, approvalPending: true }) === "acceptTool");
check("without a pending card ⌘Enter passes through, so it still sends", verdict("Meta+Enter", { ...composer, approvalPending: false }) === "pass");
check("in the code editor and the terminal they never fire", verdict("Meta+Enter", { ...base, inEditor: true, approvalPending: true }) === "pass" && verdict("Meta+Enter", { ...base, inTerminal: true, approvalPending: true }) === "pass");
check("Enter alone and ⇧Enter are untouched", verdict("Enter", composer) === "pass" && verdict("Shift+Enter", composer) === "pass");
check("the existing ⇧⌘A (focus the card) is still there", verdict("Shift+Meta+KeyA", base) === "focusApproval");
check("the keys depend on context, so Electron's menu interception must not swallow them", !INTERCEPT_STROKES.has("Meta+Enter") && !INTERCEPT_STROKES.has("Alt+Meta+Enter"));
check("the table has exactly one binding per key", BINDINGS.filter((b) => b.keys[0] === "Meta+Enter").length === 1 && BINDINGS.filter((b) => b.keys[0] === "Alt+Meta+Enter").length === 1);
const palette = paletteCommands();
check("the command palette lists both with their keys", palette.find((c) => c.command === "acceptTool")?.keycaps.join("") === "⌘Enter" && palette.find((c) => c.command === "skipTool")?.keycaps.join("") === "⌥⌘Enter", JSON.stringify(palette.filter((c) => /Tool/.test(c.command))));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
