import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const QUIET = [
  "pathCopied", "copied", "inboxCopied", "mcpCopied", "linkCopied",
  "noOpenFile", "searchNeedsFolder", "handoffNoSession", "worktreeOnly", "noApprovalPending", "openSessionFirst", "tabFocusOn", "tabFocusOff",
  "browserNeedsTab", "focusTerminalFirst", "splitNeedsTab", "splitNeedsAnotherTab", "noClosedEditor", "noClosedChat", "commandNoSelectedFile", "noEditorsOpen",
  "effortCycled", "discardNothing", "btwNeedsSession", "renameNeedsSession", "handoffGeneratingBusy", "linkInvalid", "attachMenuUnavailable",
  "browserPermissionsNoOrigin", "fixWithClaudeReady", "formatNeedsEditor", "formatUnchanged", "formattedWith", "noFormatter", "quickFixNone", "selectCodeFirst",
  "noProblems", "definitionNotFound", "renameNothing", "renamed", "noTypeHere", "noSignatureHere", "noTrackedRemote", "nothingToSync", "folderLocated",
  "browserWebOnly", "browserPicking", "browserPickingComment", "browserPickingArea", "browserDesktopOnly", "browserShareStopped", "browserShareNeedsSession",
  "browserElementAdded", "browserCommentAdded", "browserConsoleAdded", "browserPageShared", "browserPageSharedNoShot", "browserAreaAdded", "inboxNoWorkspace",
  "needMessage", "nothingToCommit", "markedResolved", "fetchDone", "upToDate", "feedbackSent",
];

const root = join(import.meta.dirname, "..", "web");
const files = readdirSync(root).filter((name) => /\.(ts|tsx)$/.test(name));
const source = new Map(files.map((name) => [name, readFileSync(join(root, name), "utf8")]));

const flashed: string[] = [];
for (const [name, text] of source) {
  text.split("\n").forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const call of line.match(/\bflash\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
      for (const key of QUIET) if (new RegExp(`\\b[SM]\\.${key}\\b`).test(call)) flashed.push(`${name}:${i + 1} ${key}`);
    }
  });
}
check("no quiet message goes through flash", flashed.length === 0, flashed.join(", "));

const strings = [source.get("strings.ts") ?? "", source.get("scmStrings.ts") ?? ""].join("\n");
const missing = QUIET.filter((key) => !new RegExp(`\\b${key}\\b\\s*:`).test(strings));
check("every listed key exists in the string tables", missing.length === 0, missing.join(", "));

const used = QUIET.filter((key) => [...source.values()].some((text) => new RegExp(`\\b(hint|announce)\\([^\\n]*\\b[SM]\\.${key}\\b`).test(text)));
const unused = QUIET.filter((key) => !used.includes(key));
check("every listed message is shown through hint or announce", unused.length === 0, unused.join(", "));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("quiet toasts: all passed");
