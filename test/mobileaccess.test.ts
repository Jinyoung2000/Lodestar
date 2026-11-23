import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { compactTimelineItem, MOBILE_METHODS, MOBILE_OUTPUT_CHARS, pageOfTimeline } from "../shared/mobile";
import { MAX_IMAGE_BYTES } from "../shared/images";
import type { ServerEvent, TimelineItem } from "../shared/protocol";
import { listFolder, resolveAddable, resolveFolder, BROWSE_LIMIT } from "../server/mobileFolders";
import { AttemptLimiter, guardMobileCall, lanHosts, makeOffer, MobileDevices, MobileServer, PairingCodes, shapeMobileEvent } from "../server/mobileAccess";
import { findWorkspaceIcon, WorkspaceIcons } from "../server/workspaceIcons";
import { freeTestPort, useTestDaemon } from "./testDaemon";

type Case = { name: string; run: () => Promise<string> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run: async () => run() });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const rejects = (run: () => unknown, pattern: RegExp, label: string) => {
  try {
    run();
  } catch (error) {
    return expect(pattern.test((error as Error).message), `${label}: wrong message ${(error as Error).message}`);
  }
  throw new Error(`${label}: did not throw`);
};

test("PairingCodes: 맞는 코드는 한 번만 쓰이고, 소문자와 하이픈도 받는다", () => {
  const codes = new PairingCodes();
  const { code } = codes.issue();
  expect(/^[A-HJ-NP-Z2-9]{8}$/.test(code), `alphabet ${code}`);
  expect(codes.redeem(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase()) === "ok", "lowercase with hyphen");
  expect(codes.redeem(code) === "invalid", "second use is invalid");
  return code;
});

test("PairingCodes: 5분이 지나면 만료되고, 새 코드가 이전 코드를 무효로 한다", () => {
  let now = 1_000_000;
  const codes = new PairingCodes({ now: () => now });
  const first = codes.issue();
  now += 5 * 60_000 - 1;
  expect(codes.active !== null, "still active just before the TTL");
  now += 2;
  expect(codes.redeem(first.code) === "expired", "expired after TTL");
  const second = codes.issue();
  const third = codes.issue();
  expect(codes.redeem(second.code) === "invalid", "an older code stops working when a new one is issued");
  expect(codes.redeem(third.code) === "ok", "the newest works");
  return "ok";
});

test("PairingCodes: 틀린 코드 5번이면 맞는 코드도 못 쓴다", () => {
  const codes = new PairingCodes();
  const { code } = codes.issue();
  const wrong = code.startsWith("A") ? "BBBBBBBB" : "AAAAAAAA";
  const results = [1, 2, 3, 4, 5].map(() => codes.redeem(wrong));
  expect(results.slice(0, 4).every((r) => r === "invalid") && results[4] === "locked", results.join(","));
  expect(codes.redeem(code) === "invalid", "burned code is gone");
  expect(codes.redeem(undefined) === "invalid" && codes.redeem({}) === "invalid", "non-string input");
  return results.join(",");
});

test("AttemptLimiter: 창 안에서 최대 횟수만 허용한다", () => {
  let now = 0;
  const limiter = new AttemptLimiter(3, 1000, () => now);
  const first = [limiter.take(), limiter.take(), limiter.take(), limiter.take()];
  now = 1001;
  expect(first.join() === "true,true,true,false" && limiter.take(), first.join());
  return "ok";
});

test("MobileDevices: 토큰 원문은 파일에 없고, 해제하면 토큰이 통하지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
  const file = join(dir, "mobile-devices.json");
  try {
    const devices = new MobileDevices(file);
    const { device, token } = devices.add("  Alex's iPhone\u0007 ");
    expect(device.name === "Alex's iPhone", `name sanitized: ${JSON.stringify(device.name)}`);
    expect(!readFileSync(file, "utf8").includes(token), "token is not stored in clear");
    expect((statSync(file).mode & 0o777) === 0o600, "file mode 600");
    expect(devices.verify(token)?.id === device.id, "token verifies");
    expect(new MobileDevices(file).verify(token)?.id === device.id, "survives reload");
    expect(devices.verify(token.slice(0, 63) + (token.endsWith("0") ? "1" : "0")) === null, "one wrong char");
    expect(devices.verify("deadbeef") === null && devices.verify(undefined) === null && devices.verify("x".repeat(64)) === null, "bad shapes");
    const other = devices.add("iPad");
    expect(devices.verify(other.token)?.id !== device.id, "tokens differ per device");
    devices.revoke(device.id);
    expect(devices.verify(token) === null && devices.verify(other.token) !== null, "revoked only that device");
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardMobileCall: 허용 목록 밖은 모두 거절한다", () => {
  const blocked = ["files.write", "files.save", "search.replace", "files.create", "files.trash", "files.read", "settings.set", "settings.get", "pty.info", "format.run", "git.push", "worktree.merge", "agents.setPermissionMode", "agents.remove", "agents.fork", "agents.timeline", "images.upload", "mobile.status", "mobile.pairingCode", "mobile.revokeDevice", "daemon.restartIfIdle", "browser.toolResult", "workspaces.relocate", "workspaces.reveal", "scm.openWorktree", "git.switchBranch", "agents.respondNotionWrite", "mcp.toggle", "board.createCard", "notion.pins.add", "feedback.create", "toString", "__proto__", ""];
  for (const method of blocked) rejects(() => guardMobileCall(method, {}), /cannot call/, method);
  for (const method of MOBILE_METHODS) expect(!blocked.includes(method), `${method} is both allowed and blocked`);
  return `${blocked.length} blocked, ${MOBILE_METHODS.length} allowed`;
});

test("guardMobileCall: 인자를 검사하고 새 객체로 만든다", () => {
  expect(JSON.stringify(guardMobileCall("agents.send", { agentId: "a", prompt: "hi", extra: "ignored", permissionMode: "bypassPermissions" })) === '{"agentId":"a","prompt":"hi","steer":false}', "extra keys dropped, steer defaults to false");
  expect(guardMobileCall("agents.send", { agentId: "a", prompt: "hi", steer: true }).steer === true, "steer");
  rejects(() => guardMobileCall("agents.send", { agentId: "a" }), /Invalid prompt/, "missing prompt");
  rejects(() => guardMobileCall("agents.send", { agentId: "", prompt: "x" }), /Invalid agentId/, "empty id");
  rejects(() => guardMobileCall("agents.send", { agentId: "a", prompt: "x".repeat(50_001) }), /Invalid prompt/, "huge prompt");
  rejects(() => guardMobileCall("agents.respondPermission", { agentId: "a", itemId: "i", decision: "allowAlways" }), /Invalid decision/, "allowAlways");
  expect(guardMobileCall("agents.respondPermission", { agentId: "a", itemId: "i", decision: "deny" }).decision === "deny", "deny passes");
  rejects(() => guardMobileCall("agents.timelinePage", { agentId: "a", limit: 100_000 }), /Invalid limit/, "limit");
  rejects(() => guardMobileCall("agents.timelinePage", { agentId: "a", limit: 1.5 }), /Invalid limit/, "fractional limit");
  const image = { id: "11111111-1111-4111-8111-111111111111", label: "x", thumb: "data:image/jpeg;base64,AAAA" };
  expect((guardMobileCall("agents.send", { agentId: "a", prompt: "", images: [image] }).images as unknown[]).length === 1, "image ref");
  rejects(() => guardMobileCall("agents.send", { agentId: "a", prompt: "", images: [{ ...image, id: "../../etc/passwd" }] }), /Invalid images/, "path-like image id");
  rejects(() => guardMobileCall("agents.send", { agentId: "a", prompt: "", images: Array(6).fill(image) }), /Invalid images/, "too many images");
  const create = guardMobileCall("agents.create", { workspaceId: "w", prompt: "go", permissionMode: "bypassPermissions", model: "opus", effort: "max" });
  expect(JSON.stringify(create) === '{"workspaceId":"w","prompt":"go"}', `create keeps only workspace and prompt: ${JSON.stringify(create)}`);
  const withWorktree = guardMobileCall("agents.create", { workspaceId: "w", prompt: "go", permissionMode: "bypassPermissions", worktree: { branch: "feature/x", base: "origin/main", path: "/etc" } });
  expect(JSON.stringify(withWorktree) === '{"workspaceId":"w","prompt":"go","worktree":{"branch":"feature/x","base":"origin/main"}}', `worktree keeps only branch and base: ${JSON.stringify(withWorktree)}`);
  expect(!("worktree" in guardMobileCall("agents.create", { workspaceId: "w", prompt: "go", worktree: null })), "null worktree is dropped");
  expect(guardMobileCall("agents.create", { workspaceId: null, prompt: "chat" }).workspaceId === null, "folderless chat");
  expect(guardMobileCall("agents.respondPlan", { agentId: "a", itemId: "i", approve: true, mode: "bypassPermissions" }).mode === "acceptEdits", "plan approval cannot pick bypass");
  rejects(() => guardMobileCall("agents.answerQuestion", { agentId: "a", itemId: "i", answers: { q: 5 } }), /Invalid answers/, "non-string answer");
  rejects(() => guardMobileCall("agents.setOpen", { agentIds: Array(11).fill("a") }), /Invalid agentIds/, "too many open");
  return "ok";
});

test("guardMobileCall: 워크스페이스와 세션 관리 호출의 인자를 검사한다", () => {
  const base = { workspaceId: "w", prompt: "go" };
  for (const bad of ["--upload-pack=x", "-b", "a b", "a\nb", "", "x".repeat(201)]) rejects(() => guardMobileCall("agents.create", { ...base, worktree: { branch: "ok", base: bad } }), /Invalid base/, `base ${JSON.stringify(bad)}`);
  for (const bad of ["-x", "a b", "", "x".repeat(201)]) rejects(() => guardMobileCall("agents.create", { ...base, worktree: { branch: bad, base: "main" } }), /Invalid branch/, `branch ${JSON.stringify(bad)}`);
  rejects(() => guardMobileCall("agents.create", { workspaceId: null, prompt: "chat", worktree: { branch: "x", base: "main" } }), /Invalid worktree/, "chat with worktree");
  expect(JSON.stringify(guardMobileCall("agents.rename", { agentId: "a", title: "  Fix\nthe   bug  ", extra: 1 })) === '{"agentId":"a","title":"Fix the   bug"}', "rename trims and flattens control characters");
  expect((guardMobileCall("agents.rename", { agentId: "a", title: "가".repeat(500) }).title as string).length === 200, "rename is cut at 200");
  rejects(() => guardMobileCall("agents.rename", { agentId: "a", title: "x".repeat(2001) }), /Invalid title/, "huge title");
  rejects(() => guardMobileCall("agents.rename", { agentId: "a", title: 5 }), /Invalid title/, "non-string title");
  rejects(() => guardMobileCall("agents.setPinned", { agentId: "a", pinned: "yes" }), /Invalid pinned/, "pinned must be boolean");
  rejects(() => guardMobileCall("agents.setDone", { agentId: "a" }), /Invalid done/, "done must be boolean");
  expect(JSON.stringify(guardMobileCall("agents.setDone", { agentId: "a", done: true, x: 1 })) === '{"agentId":"a","done":true}', "setDone keeps only its fields");
  rejects(() => guardMobileCall("workspaces.remove", { id: "" }), /Invalid id/, "remove needs an id");
  expect(JSON.stringify(guardMobileCall("workspaces.remove", { id: "w", removeFiles: true })) === '{"id":"w"}', "remove has no file option");
  rejects(() => guardMobileCall("git.branches", {}), /Invalid workspaceId/, "branches needs a workspace");
  rejects(() => guardMobileCall("git.checkBranchName", { workspaceId: "w", branch: "x".repeat(201) }), /Invalid branch/, "long branch");
  return "ok";
});

function browseFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mobile-browse-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "mobile-outside-")));
  mkdirSync(join(root, "Repos", "app", ".git"), { recursive: true });
  mkdirSync(join(root, "Repos", "app", "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, "Repos", "app.worktrees", "feature"), { recursive: true });
  writeFileSync(join(root, "Repos", "app.worktrees", "feature", ".git"), "gitdir: /x\n");
  mkdirSync(join(root, "Repos", "plain"), { recursive: true });
  writeFileSync(join(root, "Repos", "notes.txt"), "secret notes");
  mkdirSync(join(root, ".ssh"), { recursive: true });
  mkdirSync(join(root, "Library", "Caches"), { recursive: true });
  mkdirSync(join(root, "Repos", "Library"), { recursive: true });
  mkdirSync(join(outside, "elsewhere"), { recursive: true });
  symlinkSync(outside, join(root, "Repos", "to-outside"));
  symlinkSync(join(root, ".ssh"), join(root, "Repos", "to-hidden"));
  symlinkSync(join(root, "Repos", "plain"), join(root, "Repos", "alias-plain"));
  return { root, outside, stop: () => (rmSync(root, { recursive: true, force: true }), rmSync(outside, { recursive: true, force: true })) };
}

test("프로젝트 아이콘: 앱 아이콘을 웹 파비콘보다 먼저 찾고, 모노레포 앱 폴더도 보며, 폴더 밖을 가리키는 링크와 svg 는 건너뛴다", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-icon-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-icon-outside-")));
  const png = readFileSync(join(process.cwd(), "mobile", "assets", "project-marks", "claude.png"));
  try {
    writeFileSync(join(outside, "secret.png"), png);
    mkdirSync(join(root, "public"), { recursive: true });
    symlinkSync(join(outside, "secret.png"), join(root, "icon.png"));
    writeFileSync(join(root, "public", "favicon.svg"), "<svg/>");
    expect(findWorkspaceIcon(root) === null, "a link that leaves the folder and an svg give no icon");
    writeFileSync(join(root, "public", "favicon.png"), png);
    const favicon = findWorkspaceIcon(root);
    expect(favicon?.path === join(root, "public", "favicon.png") && favicon.uri.startsWith("data:image/png;base64,"), `favicon found: ${favicon?.path}`);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "icon.png"), png);
    expect(findWorkspaceIcon(root)?.path === join(root, "assets", "icon.png"), "the app icon wins over the favicon");
    const mono = realpathSync(mkdtempSync(join(tmpdir(), "workspace-icon-mono-")));
    mkdirSync(join(mono, "apps", "web", "public"), { recursive: true });
    writeFileSync(join(mono, "apps", "web", "public", "apple-touch-icon.png"), png);
    expect(findWorkspaceIcon(mono)?.path === join(mono, "apps", "web", "public", "apple-touch-icon.png"), "monorepo app folder is searched");
    rmSync(mono, { recursive: true, force: true });
    const icons = new WorkspaceIcons();
    const first = icons.icon(root);
    expect(first !== null && icons.icon(root) === first, "the cached icon is returned again");
    return expect(icons.icon(join(root, "missing")) === null, "a missing folder gives null");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("폴더 둘러보기: 홈 아래 디렉터리 이름과 git 여부만 주고, 숨김과 시스템 폴더와 링크와 파일은 뺀다", () => {
  const f = browseFixture();
  try {
    const home = listFolder(resolveFolder(undefined, f.root), new Map(), f.root);
    expect(home.path === "~" && home.parent === null && !home.git && JSON.stringify(home.entries.map((e) => e.name)) === '["Repos"]', `home lists only Repos: ${JSON.stringify(home.entries)}`);
    const repos = listFolder(resolveFolder("~/Repos", f.root), new Map(), f.root);
    expect(repos.parent === "~", `parent ${repos.parent}`);
    const names = repos.entries.map((e) => e.name);
    expect(JSON.stringify(names) === '["app","app.worktrees","Library","plain"]', `entries ${JSON.stringify(names)}`);
    for (const hidden of ["notes.txt", "to-outside", "to-hidden", "alias-plain"]) expect(!names.includes(hidden), `${hidden} must not be listed`);
    const byName = Object.fromEntries(repos.entries.map((e) => [e.name, e]));
    expect(byName.app.git && !byName["app.worktrees"].git && !byName.plain.git, "git flag is on the repository only");
    expect(JSON.stringify(Object.keys(byName.app).sort()) === '["git","name","workspaceId"]', "an entry has a name, a git flag and a workspace id and nothing else (no sizes, times or contents)");
    const app = listFolder(resolveFolder("~/Repos/app", f.root), new Map(), f.root);
    expect(app.git && !app.entries.some((e) => e.name === "node_modules"), "node_modules is not listed");
    const worktree = listFolder(resolveFolder("~/Repos/app.worktrees/feature", f.root), new Map(), f.root);
    expect(worktree.git, "a worktree (.git file) counts as git");
    const known = listFolder(resolveFolder("~/Repos", f.root), new Map([[join(f.root, "Repos", "plain"), "ws-1"]]), f.root);
    expect(known.entries.find((e) => e.name === "plain")?.workspaceId === "ws-1", "an added folder carries its workspace id");
    return names.join();
  } finally {
    f.stop();
  }
});

test("폴더 경로: 홈 밖, 숨김, 시스템 폴더, 링크 우회, 파일은 모두 같은 말로 거절한다", () => {
  const f = browseFixture();
  try {
    const denied = /visible folders inside your home/;
    for (const path of ["/", "/etc", "/Users", "~/..", "~/../..", "~/Repos/../..", f.outside, "~/Repos/to-outside", "~/Repos/to-outside/elsewhere", "~/.ssh", ".ssh", "~/Repos/to-hidden", "~/Library", "~/Library/Caches", "~/Repos/app/node_modules", "~/Repos/app/node_modules/dep"]) {
      rejects(() => resolveFolder(path, f.root), denied, `browse ${path}`);
      rejects(() => resolveAddable(path, f.root), denied, `add ${path}`);
    }
    rejects(() => resolveFolder("/definitely/not/there", f.root), denied, "missing outside");
    rejects(() => resolveFolder(join(f.outside, "nope"), f.root), denied, "missing next to outside");
    rejects(() => resolveFolder("~/Repos/missing", f.root), /does not exist/, "missing inside");
    rejects(() => resolveFolder("~/Repos/notes.txt", f.root), denied, "a file is not a folder");
    rejects(() => resolveFolder({}, f.root), /Invalid path/, "object");
    rejects(() => resolveFolder("a\0b", f.root), /Invalid path/, "nul byte");
    expect(resolveFolder("~/Repos/Library", f.root).display === "~/Repos/Library", "nested Library is an ordinary folder");
    return "ok";
  } finally {
    f.stop();
  }
});

test("폴더 경로: 홈 아래 폴더는 여러 표기(~, 절대, 상대, 끝 슬래시)로 같은 곳을 가리키고, 추가는 홈 자체를 거절한다", () => {
  const f = browseFixture();
  try {
    const want = join(f.root, "Repos", "plain");
    for (const path of ["~/Repos/plain", join(f.root, "Repos", "plain"), "Repos/plain", "~/Repos/plain/", "~/Repos/./plain", "~/Repos/app/../plain", "~/Repos/alias-plain"]) {
      const folder = resolveAddable(path, f.root);
      expect(folder.dir === want && folder.display === "~/Repos/plain", `${path} -> ${folder.dir} ${folder.display}`);
    }
    expect(resolveFolder("", f.root).display === "~" && resolveFolder("~", f.root).dir === f.root && resolveFolder(undefined, f.root).dir === f.root, "home itself can be browsed");
    rejects(() => resolveAddable("~", f.root), /not the home folder itself/, "add home");
    rejects(() => resolveAddable("", f.root), /not the home folder itself/, "add empty");
    expect(guardMobileCall("workspaces.add", { dir: "~/Repos/plain", force: true }, f.root).dir === want, "guard resolves to the absolute path");
    expect(JSON.stringify(Object.keys(guardMobileCall("workspaces.add", { dir: "~/Repos/plain" }, f.root))) === '["dir"]', "only dir is passed on");
    rejects(() => guardMobileCall("workspaces.add", { dir: "/etc" }, f.root), /visible folders/, "guard add /etc");
    rejects(() => guardMobileCall("workspaces.add", { dir: "~" }, f.root), /not the home folder itself/, "guard add home");
    rejects(() => guardMobileCall("workspaces.add", {}, f.root), /not the home folder itself/, "guard add nothing means home");
    rejects(() => guardMobileCall("mobile.browse", { path: "~/.ssh" }, f.root), /visible folders/, "guard browse hidden");
    expect(guardMobileCall("mobile.browse", { path: "~/Repos" }, f.root).display === "~/Repos", "guard browse");
    return "ok";
  } finally {
    f.stop();
  }
});

test("폴더 둘러보기: 항목이 500개를 넘으면 잘리고 잘렸다고 알린다", () => {
  const f = browseFixture();
  try {
    for (let i = 0; i < BROWSE_LIMIT + 5; i++) mkdirSync(join(f.root, "Many", `d${String(i).padStart(4, "0")}`), { recursive: true });
    const many = listFolder(resolveFolder("~/Many", f.root), new Map(), f.root);
    expect(many.entries.length === BROWSE_LIMIT && many.truncated, `${many.entries.length} ${many.truncated}`);
    expect(!listFolder(resolveFolder("~/Repos", f.root), new Map(), f.root).truncated, "small folders are not truncated");
    return String(many.entries.length);
  } finally {
    f.stop();
  }
});

const toolItem = (output: string): TimelineItem => ({ id: "t1", kind: "tool", name: "Bash", input: { command: "x".repeat(5000), nested: { list: ["y".repeat(5000)] } }, status: "done", output, shots: ["/tmp/a.png"] });

test("compactTimelineItem: 긴 도구 입출력과 스크린샷 경로를 줄이고 모양은 그대로 둔다", () => {
  const compact = compactTimelineItem(toolItem("z".repeat(10_000))) as Extract<TimelineItem, { kind: "tool" }>;
  expect(compact.output!.length < MOBILE_OUTPUT_CHARS + 60 && compact.output!.includes("more characters"), `output ${compact.output!.length}`);
  expect((compact.input.command as string).length < 2100, "input string clipped");
  expect(((compact.input.nested as { list: string[] }).list[0]).length < 2100, "nested clipped");
  expect(!("shots" in compact), "shots removed");
  const short = toolItem("ok");
  expect(compactTimelineItem({ id: "a", kind: "assistant", text: "x".repeat(20_000), streaming: false }).kind === "assistant" && (compactTimelineItem({ id: "a", kind: "assistant", text: "x".repeat(20_000), streaming: false }) as { text: string }).text.length === 20_000, "assistant text is never clipped");
  expect((compactTimelineItem(short) as Extract<TimelineItem, { kind: "tool" }>).output === "ok", "short output unchanged");
  const permission = compactTimelineItem({ id: "p", kind: "permission", toolName: "Write", input: { file_path: "/a", content: "c".repeat(9000) }, status: "pending", notion: { kind: "update", pageId: "x" } as never });
  expect(!("notion" in permission) && ((permission as unknown as { input: { content: string } }).input.content.length < 2100), "permission input clipped, notion preview dropped");
  return "ok";
});

test("pageOfTimeline: 끝에서 limit 개, beforeId 로 옛 쪽을 이어 받는다", () => {
  const items: TimelineItem[] = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, kind: "assistant", text: String(i), streaming: false }));
  const last = pageOfTimeline(items, 10);
  expect(last.items.map((i) => i.id).join() === "i15,i16,i17,i18,i19,i20,i21,i22,i23,i24" && last.hasMore && last.total === 25, "tail");
  const older = pageOfTimeline(items, 10, "i15");
  expect(older.items[0].id === "i5" && older.items.at(-1)!.id === "i14" && older.hasMore, "older");
  const oldest = pageOfTimeline(items, 10, "i5");
  expect(oldest.items.length === 5 && !oldest.hasMore, "oldest");
  expect(pageOfTimeline(items, 50).items.length === 25 && !pageOfTimeline(items, 50).hasMore, "all");
  expect(pageOfTimeline(items, 3, "missing").items.at(-1)!.id === "i24", "unknown beforeId means the tail");
  return "ok";
});

test("shapeMobileEvent: 데스크톱 전용 이벤트는 보내지 않고 피드백 세션은 숨긴다", () => {
  const dropped = ["settings", "inbox", "board", "notes", "notionPins", "notionChanged", "notionChats", "feedback", "quick", "side", "termask", "meta", "changes", "reload", "browserTool", "browserOpen", "workspaceChanged", "diffFeedback", "review", "showAgent", "notionStartSession"];
  for (const type of dropped) expect(shapeMobileEvent({ type } as unknown as ServerEvent) === null, `${type} must not reach the phone`);
  const agent = { id: "a", feedbackId: null, title: "t" } as never;
  expect(shapeMobileEvent({ type: "agent", agent }) !== null, "agent passes");
  expect(shapeMobileEvent({ type: "agent", agent: { id: "f", feedbackId: "fb" } as never }) === null, "feedback agent hidden");
  const workspaces = shapeMobileEvent({ type: "workspaces", workspaces: [{ id: "1", name: "a", dir: "/a", parentId: null }, { id: "2", name: "fb", dir: "/b", parentId: null, feedback: true }] });
  expect(workspaces?.type === "workspaces" && workspaces.workspaces.length === 1, "feedback workspace hidden");
  const upsert = shapeMobileEvent({ type: "timelineUpsert", agentId: "a", item: toolItem("z".repeat(10_000)) });
  expect(upsert?.type === "timelineUpsert" && (upsert.item as { output: string }).output.length < 4100, "upsert compacted");
  return `${dropped.length} dropped`;
});

test("lanHosts: 가상 인터페이스와 링크 로컬은 빼고 Wi-Fi 를 앞에, Tailscale 주소를 뒤에 둔다", () => {
  const info = (address: string, internal = false) => [{ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }] as never;
  const hosts = lanHosts({ lo0: info("127.0.0.1", true), utun3: info("100.88.1.2"), awdl0: info("169.254.1.1"), bridge100: info("192.168.64.1"), en5: info("10.0.0.7"), en0: info("192.168.0.10"), en1: [{ address: "fe80::1", family: "IPv6", internal: false, netmask: "", mac: "", cidr: null, scopeid: 1 }] as never } as never);
  expect(hosts.map((h) => h.address).join() === "192.168.0.10,10.0.0.7,100.88.1.2", hosts.map((h) => h.address).join());
  expect(hosts.at(-1)?.kind === "tailscale" && hosts.slice(0, 2).every((h) => h.kind === "lan"), "tailscale-range address on a tunnel interface is kept, last");
  const tail = lanHosts({ en0: info("192.168.0.2"), en7: info("100.101.102.103") } as never);
  expect(tail.map((h) => `${h.address}:${h.kind}`).join() === "192.168.0.2:lan,100.101.102.103:tailscale", "tailscale-range address is labelled and ordered last");
  return "ok";
});

test("makeOffer: QR 주소와 수동 입력 문자열에 코드와 모든 호스트가 든다", () => {
  const offer = makeOffer({ code: "ABCD2345", expiresAt: 5 }, [{ address: "192.168.0.5", iface: "en0", kind: "lan" }, { address: "100.64.0.9", iface: "en7", kind: "tailscale" }], 7789, "Alex's Mac");
  const url = new URL(offer.uri);
  expect(url.protocol === "lodestar:" && url.searchParams.get("h") === "192.168.0.5,100.64.0.9" && url.searchParams.get("p") === "7789" && url.searchParams.get("c") === "ABCD2345" && url.searchParams.get("n") === "Alex's Mac", offer.uri);
  expect(offer.manual === "192.168.0.5:7789 ABCD-2345" && offer.code === "ABCD-2345", offer.manual);
  return offer.manual;
});

type Client = { ws: WebSocket; messages: unknown[]; next: (predicate?: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>; closed: Promise<number> };

function connect(port: number, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mobile/ws`, { headers });
    const messages: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(String(data)));
      for (const w of waiters.splice(0)) w();
    });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    const next: Client["next"] = async (predicate = () => true, ms = 2000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const index = messages.findIndex(predicate);
        if (index !== -1) return messages.splice(index, 1)[0];
        if (Date.now() > deadline) throw new Error("timed out waiting for a message");
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    };
    ws.once("open", () => resolve({ ws, messages, next, closed }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
}

function http(port: number, method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function memoryServer(extra: { allowedOrigins?: Set<string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mobile-server-"));
  const devices = new MobileDevices(join(dir, "mobile-devices.json"));
  const pairing = new PairingCodes();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const saved: { size: number; type: string; name: string }[] = [];
  const server = new MobileServer({
    devices,
    pairing,
    call: (method, params) => {
      calls.push({ method, params });
      if (method === "mobile.ping") return { now: 1 };
      if (method === "agents.list") return [{ id: "a1" }];
      throw new Error("handler exploded");
    },
    saveImage: (bytes, type, name) => {
      saved.push({ size: bytes.length, type, name });
      return { id: "11111111-1111-4111-8111-111111111111" };
    },
    hostName: "TestMac",
    allowedOrigins: extra.allowedOrigins,
  });
  await server.start(0, "127.0.0.1");
  const pair = async (name = "Test iPhone") => {
    const { code } = pairing.issue();
    const reply = await http(server.port, "POST", "/mobile/pair", JSON.stringify({ code, deviceName: name }));
    return { reply, token: reply.json.deviceToken as string, deviceId: reply.json.deviceId as string };
  };
  const login = async (token: string) => {
    const client = await connect(server.port);
    client.ws.send(JSON.stringify({ auth: token }));
    const ready = await client.next((m) => "ready" in m);
    return { client, ready };
  };
  const stop = async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { server, devices, pairing, calls, saved, pair, login, stop };
}

test("서버: 페어링 코드로 장치 토큰을 받고, 그 토큰으로 인증해 허용된 호출만 실행한다", async () => {
  const m = await memoryServer();
  try {
    const { reply, token } = await m.pair();
    expect(reply.status === 200 && /^[0-9a-f]{64}$/.test(token) && reply.json.host === "TestMac", JSON.stringify(reply.json));
    const { client, ready } = await m.login(token);
    expect((ready.ready as { protocol: number }).protocol === 1, "ready");
    client.ws.send(JSON.stringify({ id: 1, method: "mobile.ping", params: {} }));
    expect(JSON.stringify(await client.next((x) => x.id === 1)) === '{"id":1,"result":{"now":1}}', "ping result");
    client.ws.send(JSON.stringify({ id: 2, method: "files.write", params: { agentId: "a", path: "x", text: "pwn" } }));
    const denied = await client.next((x) => x.id === 2);
    expect(typeof denied.error === "string" && /cannot call/.test(denied.error as string), JSON.stringify(denied));
    client.ws.send(JSON.stringify({ id: 3, method: "settings.set", params: { mobileAccess: false } }));
    expect(/cannot call/.test(String((await client.next((x) => x.id === 3)).error)), "settings.set denied");
    client.ws.send(JSON.stringify({ id: 4, method: "agents.send", params: { agentId: "a" } }));
    expect(/Invalid prompt/.test(String((await client.next((x) => x.id === 4)).error)), "bad params denied");
    client.ws.send(JSON.stringify({ id: 5, method: "agents.interrupt", params: { agentId: "a" } }));
    expect(/handler exploded/.test(String((await client.next((x) => x.id === 5)).error)), "handler errors come back as errors");
    expect(m.calls.map((c) => c.method).join() === "mobile.ping,agents.interrupt", `only allowed calls ran: ${m.calls.map((c) => c.method).join()}`);
    client.ws.close();
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 틀린 토큰, 데스크톱 토큰 모양, 인증 없는 첫 프레임은 4401 로 끊긴다", async () => {
  const m = await memoryServer();
  try {
    for (const frame of [{ auth: "0".repeat(64) }, { auth: "deadbeef" }, { id: 1, method: "agents.list", params: {} }, { auth: 5 }]) {
      const client = await connect(m.server.port);
      client.ws.send(JSON.stringify(frame));
      expect((await client.closed) === 4401, `${JSON.stringify(frame)} closes with 4401`);
    }
    expect(m.calls.length === 0, "nothing ran");
    return "4 rejected";
  } finally {
    await m.stop();
  }
});

test("서버: 페어링 코드가 틀리면 401, 5번 틀리면 잠기고, 같은 코드로 두 번 못 받는다", async () => {
  const m = await memoryServer();
  try {
    const { code } = m.pairing.issue();
    const wrong = code.startsWith("A") ? "BBBBBBBB" : "AAAAAAAA";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await http(m.server.port, "POST", "/mobile/pair", JSON.stringify({ code: wrong, deviceName: "x" }))).status);
    expect(statuses.join() === "401,401,401,401,429", statuses.join());
    const afterLock = await http(m.server.port, "POST", "/mobile/pair", JSON.stringify({ code, deviceName: "x" }));
    expect(afterLock.status === 401 && m.devices.list().length === 0, "the real code is burned too");
    const first = await m.pair();
    expect(first.reply.status === 200, "a fresh code works");
    const second = await http(m.server.port, "POST", "/mobile/pair", JSON.stringify({ code: "AAAAAAAA", deviceName: "x" }));
    expect(second.status === 401, "no active code");
    expect((await http(m.server.port, "POST", "/mobile/pair", "not json")).status === 400, "garbage body is a 400");
    return statuses.join();
  } finally {
    await m.stop();
  }
});

test("서버: 페어링 시도가 분당 10번을 넘으면 429", async () => {
  const m = await memoryServer();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await http(m.server.port, "POST", "/mobile/pair", JSON.stringify({ code: "AAAAAAAA", deviceName: "x" }))).status);
    expect(statuses.filter((s) => s === 429).length >= 2 && statuses[10] === 429, statuses.join());
    return statuses.join();
  } finally {
    await m.stop();
  }
});

test("서버: Origin 이 있는 요청(브라우저)은 HTTP 와 WebSocket 모두 403", async () => {
  const m = await memoryServer();
  try {
    const { token } = await m.pair();
    const page = await http(m.server.port, "GET", "/mobile/health", undefined, { origin: "https://evil.example" });
    expect(page.status === 403, `health ${page.status}`);
    const pair = await http(m.server.port, "POST", "/mobile/pair", "{}", { origin: "https://evil.example" });
    expect(pair.status === 403, `pair ${pair.status}`);
    const error = await connect(m.server.port, { origin: "http://localhost:3000" }).then(
      () => null,
      (e: Error & { status?: number }) => e,
    );
    expect(error?.status === 403, `ws origin ${error?.message}`);
    const native = await http(m.server.port, "GET", "/mobile/health", undefined, { origin: `http://127.0.0.1:${m.server.port}` });
    expect(native.status === 200, `native-style origin ${native.status}`);
    const nativeWs = await connect(m.server.port, { origin: `http://127.0.0.1:${m.server.port}` });
    nativeWs.ws.close();
    for (const name of ["10.0.2.2", "192.168.0.5", "100.101.102.103", "mac.local"]) {
      const androidShaped = await http(m.server.port, "GET", "/mobile/health", undefined, { host: `${name}:${m.server.port}`, origin: `http://${name}:${m.server.port}` });
      expect(androidShaped.status === 200, `android-style origin for ${name}: ${androidShaped.status}`);
    }
    const publicName = await http(m.server.port, "GET", "/mobile/health", undefined, { host: `mac.example.com:${m.server.port}`, origin: `http://mac.example.com:${m.server.port}` });
    expect(publicName.status === 403, `public name with matching origin ${publicName.status}`);
    const rebind = await http(m.server.port, "GET", "/mobile/health", undefined, { host: "evil.example", origin: "http://evil.example" });
    expect(rebind.status === 403, `rebinding-style origin ${rebind.status}`);
    const sameHostWrongScheme = await http(m.server.port, "GET", "/mobile/health", undefined, { origin: `https://127.0.0.1:${m.server.port}` });
    expect(sameHostWrongScheme.status === 403, "other scheme");
    const ok = await http(m.server.port, "GET", "/mobile/health");
    expect(ok.status === 200 && JSON.stringify(ok.json) === '{"ok":true,"protocol":1}', "health without origin");
    expect(token.length === 64, "paired");
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 모르는 경로는 404 이고 데스크톱 화면이나 토큰을 내주지 않는다", async () => {
  const m = await memoryServer();
  try {
    for (const path of ["/", "/index.html", "/ws/rpc", "/mobile", "/mobile/token", "/../../etc/passwd"]) {
      const reply = await http(m.server.port, "GET", path);
      expect(reply.status === 404, `${path} -> ${reply.status}`);
    }
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 이미지 업로드는 장치 토큰이 필요하고 5MB 를 넘으면 413, 저장 함수는 부르지 않는다", async () => {
  const m = await memoryServer();
  try {
    const { token } = await m.pair();
    const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "image/png", "x-image-name": encodeURIComponent("사진 1.png"), ...extra });
    expect((await http(m.server.port, "POST", "/mobile/images", PNG, { "content-type": "image/png" })).status === 401, "no token");
    expect((await http(m.server.port, "POST", "/mobile/images", PNG, { authorization: `Bearer ${"0".repeat(64)}`, "content-type": "image/png" })).status === 401, "wrong token");
    const ok = await http(m.server.port, "POST", "/mobile/images", PNG, headers());
    expect(ok.status === 200 && typeof ok.json.id === "string", JSON.stringify(ok.json));
    expect(m.saved.length === 1 && m.saved[0].name === "사진 1.png" && m.saved[0].size === PNG.length && m.saved[0].type === "image/png", JSON.stringify(m.saved));
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
    const tooLarge = await http(m.server.port, "POST", "/mobile/images", big, headers()).catch(() => ({ status: 413 }));
    expect(tooLarge.status === 413, `declared length over the limit -> ${tooLarge.status}`);
    expect(m.saved.length === 1, "nothing saved for the big one");
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: Content-Length 를 속여도 5MB 를 넘으면 읽기를 멈추고 413", async () => {
  const m = await memoryServer();
  try {
    const { token } = await m.pair();
    const status = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: m.server.port }, () => {
        socket.write(`POST /mobile/images HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n`);
        const chunk = Buffer.alloc(1024 * 1024, 2);
        let sent = 0;
        const timer = setInterval(() => {
          if (socket.destroyed) return clearInterval(timer);
          socket.write(`${chunk.length.toString(16)}\r\n`);
          socket.write(chunk);
          socket.write("\r\n");
          if (++sent > 8) clearInterval(timer);
        }, 5);
      });
      let head = "";
      socket.on("data", (d) => {
        head += d.toString("latin1");
        if (head.includes("\r\n")) {
          resolve(head.split("\r\n")[0]);
          socket.destroy();
        }
      });
      socket.on("error", () => {});
      setTimeout(() => {
        resolve(head.split("\r\n")[0] || "no response");
        socket.destroy();
      }, 3000);
    });
    expect(status.includes("413"), status);
    expect(m.saved.length === 0, "nothing saved");
    return status;
  } finally {
    await m.stop();
  }
});

test("서버: 장치를 해제하면 열린 연결이 끊기고 토큰이 더는 통하지 않는다", async () => {
  const m = await memoryServer();
  try {
    const a = await m.pair("A");
    const b = await m.pair("B");
    const { client: ca } = await m.login(a.token);
    const { client: cb } = await m.login(b.token);
    expect(m.server.onlineDeviceIds().size === 2, "two online");
    m.server.revokeDevice(a.deviceId);
    expect((await ca.closed) === 4001, "A closed with 4001");
    expect(cb.ws.readyState === WebSocket.OPEN, "B stays");
    const retry = await connect(m.server.port);
    retry.ws.send(JSON.stringify({ auth: a.token }));
    expect((await retry.closed) === 4401, "A's token is dead");
    expect(m.server.devices().map((d) => `${d.name}:${d.online}`).join() === "B:true", m.server.devices().map((d) => d.name).join());
    cb.ws.close();
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 이벤트는 거르고, 같은 항목의 빠른 갱신은 하나로 묶고, 삭제는 앞선 갱신 뒤에 온다", async () => {
  const m = await memoryServer();
  try {
    const { token } = await m.pair();
    const { client } = await m.login(token);
    const item = (text: string) => ({ id: "m1", kind: "assistant" as const, text, streaming: true });
    m.server.broadcast({ type: "settings", settings: {} as never });
    for (let i = 1; i <= 20; i++) m.server.broadcast({ type: "timelineUpsert", agentId: "a", item: item("x".repeat(i)) });
    m.server.broadcast({ type: "timelineRemove", agentId: "a", itemId: "other" });
    m.server.broadcast({ type: "timelineUpsert", agentId: "a", item: { ...item("final"), streaming: false } });
    await new Promise((r) => setTimeout(r, 200));
    const events = client.messages.map((x) => (x as { event: ServerEvent }).event);
    expect(events.length === 3, `3 events, got ${events.length}: ${events.map((e) => e.type).join()}`);
    expect(events[0].type === "timelineUpsert" && (events[0].item as { text: string }).text === "x".repeat(20), "only the latest of the burst");
    expect(events[1].type === "timelineRemove", "remove after the flushed upsert");
    expect(events[2].type === "timelineUpsert" && (events[2].item as { text: string }).text === "final", "last upsert");
    client.ws.close();
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 인증 전 연결이 한꺼번에 몰리면 새 연결을 받지 않는다", async () => {
  const m = await memoryServer();
  try {
    const idle: Client[] = [];
    for (let i = 0; i < 8; i++) idle.push(await connect(m.server.port));
    const ninth = await connect(m.server.port).then(
      () => null,
      (e: Error & { status?: number }) => e,
    );
    expect(ninth?.status === 503, `9th unauthenticated socket: ${ninth?.message}`);
    for (const c of idle) c.ws.close();
    return "ok";
  } finally {
    await m.stop();
  }
});

test("서버: 끄면 포트가 닫히고 열려 있던 연결도 끊긴다", async () => {
  const m = await memoryServer();
  const port = m.server.port;
  const { token } = await m.pair();
  const { client } = await m.login(token);
  await m.server.stop();
  expect((await client.closed) === 1001, "client closed with 1001");
  const refused = await http(port, "GET", "/mobile/health").then(
    () => false,
    (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED",
  );
  expect(refused, "connection refused after stop");
  return "ok";
});

const loopback = (port: number) => new Promise<"open" | "refused">((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port }, () => {
    socket.destroy();
    resolve("open");
  });
  socket.on("error", () => resolve("refused"));
});

async function desktopRpc(daemon: { port: number; token: string }, method: string, params: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const reply = await new Promise<{ result?: unknown; error?: string }>((resolve) =>
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number };
      if (message.id === 1) resolve(message as { result?: unknown; error?: string });
    }),
  );
  ws.close();
  return reply;
}

test("데몬: 꺼져 있으면 모바일 포트가 없고, 데스크톱 포트에도 모바일 경로가 없다", async () => {
  const mobilePort = await freeTestPort();
  const daemon = await useTestDaemon({ settings: { settingsVersion: 2 }, env: { AGENT_NAV_MOBILE_PORT: String(mobilePort), AGENT_NAV_MOBILE_BIND: "127.0.0.1" } });
  try {
    expect((await loopback(mobilePort)) === "refused", "mobile port is closed");
    const status = (await desktopRpc(daemon, "mobile.status", {})).result as { enabled: boolean; listening: boolean };
    expect(status.enabled === false && status.listening === false, JSON.stringify(status));
    const pairing = await desktopRpc(daemon, "mobile.pairingCode", {});
    expect(/off/i.test(pairing.error ?? ""), `pairing code refused while off: ${pairing.error}`);
    const onDesktopPort = await http(daemon.port, "POST", "/mobile/pair", JSON.stringify({ code: "AAAAAAAA", deviceName: "x" }));
    expect(!("deviceToken" in onDesktopPort.json) && !("ok" in onDesktopPort.json), "the desktop port has no mobile routes");
    return "closed";
  } finally {
    daemon.stop();
  }
});

test("데몬: 켜면 열리고, 페어링한 폰은 세션을 읽고 보내되 쓰기 RPC 는 막히고, 끄면 닫힌다", async () => {
  const mobilePort = await freeTestPort();
  const daemon = await useTestDaemon({ settings: { settingsVersion: 2, mobileAccess: false }, env: { AGENT_NAV_MOBILE_PORT: String(mobilePort), AGENT_NAV_MOBILE_BIND: "127.0.0.1" } });
  try {
    const on = await desktopRpc(daemon, "settings.set", { mobileAccess: true });
    expect(!on.error, `settings.set ${on.error}`);
    expect((await loopback(mobilePort)) === "open", "port opens after the setting is on");
    const offer = (await desktopRpc(daemon, "mobile.pairingCode", {})).result as { code: string; uri: string; manual: string; port: number };
    expect(offer.port === mobilePort && offer.uri.startsWith("lodestar://pair?") && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(offer.code), JSON.stringify(offer));
    const paired = await http(mobilePort, "POST", "/mobile/pair", JSON.stringify({ code: offer.code, deviceName: "시험 iPhone" }));
    expect(paired.status === 200, JSON.stringify(paired.json));
    const token = paired.json.deviceToken as string;
    expect(token !== daemon.token, "the phone never gets the desktop token");

    const mainToken = await connect(mobilePort);
    mainToken.ws.send(JSON.stringify({ auth: daemon.token }));
    expect((await mainToken.closed) === 4401, "main token rejected on the mobile port");

    const phone = await connect(mobilePort);
    phone.ws.send(JSON.stringify({ auth: token }));
    await phone.next((m) => "ready" in m);
    const call = async (id: number, method: string, params: unknown) => {
      phone.ws.send(JSON.stringify({ id, method, params }));
      return phone.next((m) => m.id === id);
    };
    const list = (await call(1, "agents.list", {})).result as { id: string; title: string }[];
    expect(list.length === 1 && list[0].title === "seeded session", JSON.stringify(list));
    const workspaces = (await call(2, "workspaces.list", {})).result as { id: string }[];
    expect(workspaces.length === 1, "workspaces");
    const page = (await call(3, "agents.timelinePage", { agentId: list[0].id, limit: 20 })).result as { items: unknown[]; hasMore: boolean; total: number };
    expect(page.items.length === 0 && !page.hasMore && page.total === 0, JSON.stringify(page));
    for (const [id, method, params] of [[4, "files.write", { agentId: list[0].id, path: "tsconfig.json", text: "x" }], [5, "settings.set", { mobileAccess: false }], [6, "pty.info", { ptyId: "x" }], [7, "mobile.pairingCode", {}], [8, "agents.setPermissionMode", { agentId: list[0].id, mode: "bypassPermissions" }], [9, "daemon.restartIfIdle", {}], [10, "agents.timeline", { agentId: list[0].id }]] as const) {
      const reply = await call(id, method, params);
      expect(/cannot call/.test(String(reply.error)), `${method} -> ${JSON.stringify(reply)}`);
    }
    const unknownAgent = await call(11, "agents.timelinePage", { agentId: "nope", limit: 5 });
    expect(/Unknown agent/.test(String(unknownAgent.error)), JSON.stringify(unknownAgent));

    const upload = await http(mobilePort, "POST", "/mobile/images", PNG, { authorization: `Bearer ${token}`, "content-type": "image/png", "x-image-name": "a.png" });
    expect(upload.status === 200, JSON.stringify(upload.json));
    const stored = readdirSync(join(daemon.home, "images"));
    expect(stored.length === 1 && stored[0].startsWith(String(upload.json.id)), stored.join());
    const notAnImage = await http(mobilePort, "POST", "/mobile/images", Buffer.from("not an image"), { authorization: `Bearer ${token}`, "content-type": "image/png" });
    expect(notAnImage.status === 400, `non-image ${notAnImage.status}`);

    const status = (await desktopRpc(daemon, "mobile.status", {})).result as { listening: boolean; devices: { id: string; name: string; online: boolean }[] };
    expect(status.listening && status.devices.length === 1 && status.devices[0].name === "시험 iPhone" && status.devices[0].online, JSON.stringify(status));
    expect(!existsSync(join(daemon.home, "mobile-devices.json")) === false, "devices persisted");
    expect(!readFileSync(join(daemon.home, "mobile-devices.json"), "utf8").includes(token), "token not stored in clear");
    const revoked = await desktopRpc(daemon, "mobile.revokeDevice", { id: status.devices[0].id });
    expect((revoked.result as { devices: unknown[] }).devices.length === 0, "revoked");
    expect((await phone.closed) === 4001, "phone dropped");

    const off = await desktopRpc(daemon, "settings.set", { mobileAccess: false });
    expect(!off.error, "off");
    expect((await loopback(mobilePort)) === "refused", "port closed again");
    return "ok";
  } finally {
    daemon.stop();
  }
});

async function desktopEvents(daemon: { port: number; token: string }) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
  const events: { type: string; [key: string]: unknown }[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as { event?: { type: string } };
    if (message.event) events.push(message.event as { type: string });
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = async (predicate: (e: { type: string; [key: string]: unknown }) => boolean, label: string) => {
    for (let i = 0; i < 60; i++) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`desktop never saw ${label}`);
  };
  return { events, waitFor, close: () => ws.close() };
}

test("데몬: 폰이 폴더를 둘러보고 워크스페이스를 더하고 빼며 세션 이름과 고정과 보관을 바꾸면 데스크톱에도 방송되고, 홈 밖과 삭제는 막힌다", async () => {
  const f = browseFixture();
  const mobilePort = await freeTestPort();
  const daemon = await useTestDaemon({ settings: { settingsVersion: 2, mobileAccess: true }, env: { AGENT_NAV_MOBILE_PORT: String(mobilePort), AGENT_NAV_MOBILE_BIND: "127.0.0.1", AGENT_NAV_MOBILE_BROWSE_ROOT: f.root } });
  const desktop = await desktopEvents(daemon);
  try {
    const offer = (await desktopRpc(daemon, "mobile.pairingCode", {})).result as { code: string };
    const paired = await http(mobilePort, "POST", "/mobile/pair", JSON.stringify({ code: offer.code, deviceName: "시험 폰" }));
    const phone = await connect(mobilePort);
    phone.ws.send(JSON.stringify({ auth: paired.json.deviceToken }));
    await phone.next((m) => "ready" in m);
    let nextId = 1;
    const call = async (method: string, params: unknown) => {
      const id = nextId++;
      phone.ws.send(JSON.stringify({ id, method, params }));
      return phone.next((m) => m.id === id);
    };
    type Browse = { path: string; parent: string | null; git: boolean; workspaceId: string | null; entries: { name: string; git: boolean; workspaceId: string | null }[] };

    const home = (await call("mobile.browse", {})).result as Browse;
    expect(home.path === "~" && home.parent === null && JSON.stringify(home.entries.map((e) => e.name)) === '["Repos"]', JSON.stringify(home));
    const repos = (await call("mobile.browse", { path: "~/Repos" })).result as Browse;
    expect(repos.entries.find((e) => e.name === "app")?.git === true, "git repository is flagged");
    for (const path of ["/etc", "~/..", "~/.ssh", "~/Library", "~/Repos/to-outside"]) expect(/visible folders inside your home/.test(String((await call("mobile.browse", { path })).error)), `browse ${path} denied`);
    expect(/visible folders inside your home/.test(String((await call("workspaces.add", { dir: "/etc" })).error)), "cannot add /etc");
    expect(/not the home folder itself/.test(String((await call("workspaces.add", { dir: "~" })).error)), "cannot add the home folder");
    expect(/does not exist/.test(String((await call("workspaces.add", { dir: "~/Repos/missing" })).error)), "cannot add a folder that does not exist");
    expect(/visible folders inside your home/.test(String((await call("workspaces.add", { dir: "~/Repos/notes.txt" })).error)), "cannot add a file");

    const before = (await call("workspaces.list", {})).result as { id: string; dir: string; name: string }[];
    const added = (await call("workspaces.add", { dir: "~/Repos/plain" })).result as { id: string; dir: string; name: string };
    expect(added.dir === join(f.root, "Repos", "plain") && added.name === "plain", JSON.stringify(added));
    const seen = await desktop.waitFor((e) => e.type === "workspaces" && (e.workspaces as { id: string }[]).some((w) => w.id === added.id), "the added workspace");
    expect(Array.isArray(seen.workspaces), "desktop got the workspaces event");
    const after = (await call("mobile.browse", { path: "~/Repos" })).result as Browse;
    expect(after.entries.find((e) => e.name === "plain")?.workspaceId === added.id, "browse marks the added folder");
    expect(((await call("workspaces.list", {})).result as unknown[]).length === before.length + 1, "workspace list grew by one");
    expect(((await call("workspaces.add", { dir: "~/Repos/plain/" })).result as { id: string }).id === added.id, "adding twice returns the same workspace");

    const plainGit = (await call("git.branches", { workspaceId: added.id })).result as { repoRoot: string | null; branches: string[] };
    expect(plainGit.repoRoot === null && plainGit.branches.length === 0, JSON.stringify(plainGit));
    const seededWs = before[0];
    const seededGit = (await call("git.branches", { workspaceId: seededWs.id })).result as { repoRoot: string | null; current: string | null; branches: string[] };
    expect(seededGit.repoRoot !== null && seededGit.current === "main" && seededGit.branches.includes("main"), JSON.stringify(seededGit));
    expect(/Unknown workspace/.test(String((await call("git.branches", { workspaceId: "nope" })).error)), "unknown workspace");
    expect(((await call("git.checkBranchName", { workspaceId: seededWs.id, branch: "feature/ok" })).result as { problem: string | null }).problem === null, "good branch name");
    expect(((await call("git.checkBranchName", { workspaceId: seededWs.id, branch: "main" })).result as { problem: string | null }).problem !== null, "existing branch name is a problem");
    expect(((await call("git.checkBranchName", { workspaceId: seededWs.id, branch: "bad name" })).result as { problem: string | null }).problem !== null, "space in the name is a problem");

    expect(/Invalid base/.test(String((await call("agents.create", { workspaceId: seededWs.id, prompt: "x", worktree: { branch: "wt-a", base: "no-such-branch" } })).error)), "unknown base branch");
    expect(/Not a git repo/.test(String((await call("agents.create", { workspaceId: added.id, prompt: "x", worktree: { branch: "wt-a", base: "main" } })).error)), "non-git folder cannot get a worktree");
    expect(/Invalid base/.test(String((await call("agents.create", { workspaceId: seededWs.id, prompt: "x", worktree: { branch: "wt-a", base: "--detach" } })).error)), "option-like base");

    const agent = ((await call("agents.list", {})).result as { id: string; title: string; pinned?: boolean; done?: boolean }[])[0];
    expect(!!agent && !agent.pinned && !agent.done, JSON.stringify(agent));
    expect((await call("agents.rename", { agentId: agent.id, title: "  새   이름 " })).error === undefined, "rename ok");
    await desktop.waitFor((e) => e.type === "agent" && (e.agent as { id: string; title: string }).title === "새 이름", "the new title");
    expect(/empty/.test(String((await call("agents.rename", { agentId: agent.id, title: "   " })).error)), "empty name refused by the daemon");
    expect((await call("agents.setPinned", { agentId: agent.id, pinned: true })).error === undefined, "pin ok");
    await desktop.waitFor((e) => e.type === "agent" && (e.agent as { pinned?: boolean }).pinned === true, "pinned");
    expect((await call("agents.setDone", { agentId: agent.id, done: true })).error === undefined, "done ok");
    await desktop.waitFor((e) => e.type === "agent" && (e.agent as { done?: boolean }).done === true, "done");
    const listed = ((await call("agents.list", {})).result as { id: string; title: string; pinned?: boolean; done?: boolean }[])[0];
    expect(listed.title === "새 이름" && listed.pinned === true && listed.done === true, JSON.stringify(listed));
    expect(/Unknown agent/.test(String((await call("agents.rename", { agentId: "nope", title: "x" })).error)), "unknown agent");

    for (const [method, params] of [["agents.remove", { agentId: agent.id, removeWorktree: true }], ["workspaces.relocate", { id: added.id, dir: "~/Repos/app" }], ["scm.openWorktree", { path: "/tmp" }]] as const) expect(/cannot call/.test(String((await call(method, params)).error)), `${method} blocked`);

    desktop.events.length = 0;
    const removed = (await call("workspaces.remove", { id: added.id })).result as { hidden: number };
    expect(removed.hidden === 0, JSON.stringify(removed));
    await desktop.waitFor((e) => e.type === "workspaces" && !(e.workspaces as { id: string }[]).some((w) => w.id === added.id), "the removal");
    expect(existsSync(join(f.root, "Repos", "plain")), "the folder on disk is untouched");
    expect(!((await call("workspaces.list", {})).result as { id: string }[]).some((w) => w.id === added.id), "gone from the list");
    expect(/Unknown workspace/.test(String((await call("workspaces.remove", { id: added.id })).error)), "removing twice fails");

    const gone = (await call("workspaces.remove", { id: seededWs.id })).result as { hidden: number };
    expect(gone.hidden === 1, `hidden ${gone.hidden}`);
    expect(((await call("agents.list", {})).result as unknown[]).length === 0, "the session is hidden with its folder");
    expect(existsSync(seededWs.dir), "the seeded folder is untouched");
    return "ok";
  } finally {
    desktop.close();
    daemon.stop();
    f.stop();
  }
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
