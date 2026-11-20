// package.json 의 뷰, 명령, 메뉴, 설정이 서로, 그리고 src/ 의 코드와 맞는지 확인한다. VS Code 를 띄우지 않는다.
// 실행: npm run check (npm run package 가 먼저 돌린다)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OPEN_IN, OPEN_IN_VALUES } from "../src/chatState";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const contributes = manifest.contributes;
const source = readdirSync(join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(root, "src", f), "utf8"))
  .join("\n");

const problems: string[] = [];
const must = (condition: boolean, message: string) => {
  if (!condition) problems.push(message);
};
const matches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]);

type Entry = Record<string, string>;
const declaredCommands = new Set<string>(contributes.commands.map((c: Entry) => c.command));
const containers = new Set<string>(Object.values(contributes.viewsContainers as Record<string, Entry[]>).flatMap((list) => list.map((c) => c.id)));
const views: (Entry & { container: string })[] = Object.entries(contributes.views as Record<string, Entry[]>).flatMap(([container, list]) => list.map((v) => ({ ...v, container })));
const viewIds = new Set(views.map((v) => v.id));

// 명령: 선언한 것과 등록한 것이 같다. 코드가 부르는 lodestar.* 명령은 선언했거나 뷰의 focus 명령이다.
const registered = new Set(matches(source, /registerCommand\("([^"]+)"/g));
for (const id of declaredCommands) must(registered.has(id), `command ${id} is declared but never registered`);
for (const id of registered) must(declaredCommands.has(id), `command ${id} is registered but not declared`);
for (const id of matches(source, /executeCommand\(\s*"(lodestar\.[^"]+)"/g)) {
  const viewFocus = id.endsWith(".focus") && viewIds.has(id.slice(0, -".focus".length));
  must(declaredCommands.has(id) || viewFocus, `code runs ${id} but it is neither declared nor a view focus command`);
}

// 뷰: 컨테이너가 있고, 코드가 만드는 뷰가 선언돼 있고 종류가 맞다.
for (const v of views) must(containers.has(v.container), `view ${v.id} is in container ${v.container}, which is not declared`);
for (const id of matches(source, /createTreeView\("([^"]+)"/g)) must(views.some((v) => v.id === id && !v.type), `tree view ${id} is not declared as a tree view`);
const chatViewType = matches(source, /static readonly viewType = "([^"]+)"/g)[0];
must(views.some((v) => v.id === chatViewType && v.type === "webview"), `webview view ${chatViewType} is not declared with type webview`);
for (const event of manifest.activationEvents as string[]) if (event.startsWith("onView:")) must(viewIds.has(event.slice("onView:".length)), `activation event ${event} points at an undeclared view`);
for (const w of contributes.viewsWelcome as Entry[]) must(viewIds.has(w.view), `viewsWelcome points at undeclared view ${w.view}`);

// 메뉴: 명령이 선언돼 있고, when 이 가리키는 뷰와 컨텍스트 키가 실제로 있다.
const contextKeys = new Set(matches(source, /"setContext",\s*"([^"]+)"/g));
const clauses: { where: string; when: string }[] = [];
for (const [place, list] of Object.entries(contributes.menus as Record<string, Entry[]>)) {
  for (const item of list) {
    must(declaredCommands.has(item.command), `menu ${place} uses undeclared command ${item.command}`);
    if (item.when) clauses.push({ where: `${place} ${item.command}`, when: item.when });
  }
}
for (const w of contributes.viewsWelcome as Entry[]) if (w.when) clauses.push({ where: `viewsWelcome ${w.view}`, when: w.when });
for (const v of views) if (v.when) clauses.push({ where: `view ${v.id}`, when: v.when });
for (const { where, when } of clauses) {
  for (const id of matches(when, /view\s*(?:==|=~)\s*([\w.]+)/g)) must(viewIds.has(id), `${where}: when refers to undeclared view ${id}`);
  const withoutViews = when.replace(/view\s*(?:==|=~)\s*[\w.]+/g, "");
  for (const key of matches(withoutViews, /\b(lodestar\.[A-Za-z]+)\b/g)) must(contextKeys.has(key), `${where}: when uses context key ${key} that the code never sets`);
}

// 설정: 코드가 읽는 키가 선언돼 있고, 선택지와 기본값이 코드 상수와 같다.
const properties = contributes.configuration.properties as Record<string, { enum?: string[]; default?: unknown }>;
for (const key of matches(source, /getConfiguration\("lodestar"\)[\s\S]{0,80}?\.get(?:<[^>]*>)?\(\s*"([\w.]+)"/g).concat(matches(source, /config\.get(?:<[^>]*>)?\(\s*"([\w.]+)"/g))) must(`lodestar.${key}` in properties, `code reads setting lodestar.${key} but it is not declared`);
const openIn = properties["lodestar.openSessionIn"];
must(!!openIn, "setting lodestar.openSessionIn is not declared");
must(JSON.stringify(openIn?.enum) === JSON.stringify([...OPEN_IN_VALUES]), `lodestar.openSessionIn enum ${JSON.stringify(openIn?.enum)} differs from OPEN_IN_VALUES ${JSON.stringify(OPEN_IN_VALUES)}`);
must(openIn?.default === DEFAULT_OPEN_IN, `lodestar.openSessionIn default ${String(openIn?.default)} differs from DEFAULT_OPEN_IN ${DEFAULT_OPEN_IN}`);

// 파일: 아이콘이 있다.
for (const path of [manifest.icon, ...(contributes.viewsContainers.activitybar as Entry[]).map((c) => c.icon)]) must(existsSync(join(root, path)), `file ${path} is missing`);

if (problems.length) {
  console.error(`manifest check failed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`manifest ok: ${declaredCommands.size} commands, ${views.length} views, ${clauses.length} when clauses, ${Object.keys(properties).length} settings`);
