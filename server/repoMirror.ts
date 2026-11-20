import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerEvent } from "../shared/protocol";
import { remoteRepoRefs } from "../shared/remoteRepo";
import { runGh } from "./ghExec";
import { git } from "./git";
import { parseRemoteUrl } from "./prRepos";

// 대화가 GitHub 에서 읽은 저장소의 로컬 클론(사용자 11-04 "자주보는 레포는 클론 떠놓고 주기적으로 최신화하자", "~/Repository 에 클론하고").
// 대화의 도구 호출이 `gh api repos/OWNER/REPO/contents/...` 나 github.com/OWNER/REPO/blob/... 로 저장소를 한 번이라도 읽으면(CLONE_AFTER)
// ~/Repository/REPO 에 클론하고(이름이 다른 저장소에 쓰이고 있으면 ~/Repository/OWNER-REPO), 데몬이 떠 있는 동안 REFRESH_MS 마다 최신화한다.
// 이미 ~/Repository/REPO 가 같은 저장소의 클론이면 새로 받지 않고 그 폴더를 쓴다.
// 화면은 대화 속 그 저장소 파일 링크를 이 클론에서 연다(web/fileRefMark.ts, rpc repos.mirrorDir).
// 사용자가 직접 작업하는 폴더일 수 있어서 지우거나 덮지 않는다. 최신화는 fetch 후, 변경이 없고 기본 브랜치에 있을 때만 fast-forward 한다.

// 사용자 11-04 "그냥 한 번만 읽어도 클론하게 하자"
const CLONE_AFTER = 1;
const REFRESH_MS = 30 * 60_000;
// 클론이 실패한(권한 없음, 없는 저장소) 저장소는 하루 동안 다시 시도하지 않는다.
const RETRY_FAILED_MS = 24 * 60 * 60_000;
// 같은 도구 호출이 running, done 으로 여러 번 오니 한 번만 센다. 기억하는 id 수 상한.
const SEEN_MAX = 5000;

type Entry = { hits: number; lastSeen: string; dir?: string; clonedAt?: string; fetchedAt?: string; failedAt?: string; error?: string };

export class RepoMirrors {
  private entries: Record<string, Entry> = {};
  private seen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly file: string,
    // 시험 인스턴스는 클론하지 않는다
    private readonly blocked: () => boolean,
    // 클론 자리로 쓰지 않는 폴더. 데몬이 자기 소스로 읽어 빌드하는 폴더(server/index.ts 의 SRC_ROOT)를 받는다:
    // 그 자리가 비어 있을 때 이름이 같은 남의 저장소(아무개/agent-nav)가 클론되면 자동 업데이트가 그 저장소의 빌드 스크립트를 돌리게 된다.
    private readonly reserved: readonly string[] = [],
  ) {
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as { repos?: Record<string, Entry> }).repos ?? {};
    } catch {
      this.entries = {};
    }
  }

  // 그 저장소의 로컬 클론 폴더. 기록된 폴더, 없으면 ~/Repository 아래 같은 저장소를 가리키는 폴더. 없으면 null.
  dirOf(repo: string): string | null {
    if (!validRepo(repo)) return null;
    const recorded = this.entries[repo]?.dir;
    if (recorded && originOf(recorded) === repo) return recorded;
    const found = candidates(this.root, repo).find((dir) => originOf(dir) === repo) ?? null;
    // 찾은 클론은 기록해 두어 주기 최신화에 들어가게 한다(직접 클론해 둔 폴더도)
    if (found) this.update(repo, { dir: found });
    return found;
  }

  // 이 기능이 직접 받은 클론 폴더(사용자가 원래 갖고 있던 클론은 빠진다). 이 폴더의 코드는 실행하지 않는다(server/folderTrust.ts).
  createdDirs(): string[] {
    return Object.values(this.entries).flatMap((entry) => (entry.clonedAt && entry.dir ? [entry.dir] : []));
  }

  // 데몬이 내보내는 이벤트에서 끝난 도구 호출만 본다
  observe(event: ServerEvent) {
    if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
    if (this.seen.has(event.item.id)) return;
    if (this.seen.size >= SEEN_MAX) this.seen.clear();
    this.seen.add(event.item.id);
    const repos = new Set(remoteRepoRefs(JSON.stringify(event.item.input)).map((r) => r.repo).filter(validRepo));
    if (!repos.size) return;
    const now = new Date().toISOString();
    for (const repo of repos) {
      const entry = (this.entries[repo] ??= { hits: 0, lastSeen: now });
      entry.hits += 1;
      entry.lastSeen = now;
      if (entry.hits >= CLONE_AFTER) this.ensureClone(repo);
    }
    this.save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshAll(), REFRESH_MS);
    this.timer.unref();
    // 데몬이 뜬 직후 한 번 맞춘다(앱을 닫아 둔 사이 밀린 것)
    setTimeout(() => this.refreshAll(), 60_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 사용자가 그 저장소 파일 링크를 눌렀다. 바로 클론해 둔다(이번에는 GitHub 에서 열리고 다음부터 로컬에서 열린다).
  request(repo: string) {
    if (!validRepo(repo)) return;
    this.entries[repo] ??= { hits: 0, lastSeen: new Date().toISOString() };
    this.ensureClone(repo);
  }

  private ensureClone(repo: string) {
    if (this.blocked() || this.pending.has(repo) || this.dirOf(repo)) return;
    const entry = this.entries[repo];
    if (entry?.failedAt && Date.now() - Date.parse(entry.failedAt) < RETRY_FAILED_MS) return;
    // 비어 있는 자리에만 받는다. 이미 있는 폴더(다른 저장소, 사람이 만든 폴더)는 건드리지 않는다.
    const dir = candidates(this.root, repo).find((d) => !existsSync(d) && !this.reserved.includes(d));
    if (!dir) {
      this.update(repo, { failedAt: new Date().toISOString(), error: "no free folder name" });
      return;
    }
    this.pending.add(repo);
    this.enqueue(async () => {
      try {
        mkdirSync(dirname(dir), { recursive: true });
        await runGh(["repo", "clone", repo, dir, "--", "--quiet"]);
        this.update(repo, { dir, clonedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), failedAt: undefined, error: undefined });
        console.log(`[repos] cloned ${repo} to ${dir}`);
      } catch (error) {
        // 이번 클론이 만들다 만 폴더만 지운다(위에서 비어 있던 자리를 골랐다)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        this.update(repo, { failedAt: new Date().toISOString(), error: (error as Error).message });
        console.log(`[repos] clone ${repo} failed: ${(error as Error).message}`);
      } finally {
        this.pending.delete(repo);
      }
    });
  }

  private refreshAll() {
    if (this.blocked()) return;
    for (const repo of Object.keys(this.entries)) {
      const dir = this.dirOf(repo);
      if (!dir || this.pending.has(repo)) continue;
      this.pending.add(repo);
      this.enqueue(async () => {
        try {
          await git(dir, ["fetch", "--quiet", "--prune", "origin"], { unattended: true });
          // 기본 브랜치가 바뀌었을 수 있어 origin/HEAD 를 다시 읽는다
          await git(dir, ["remote", "set-head", "origin", "--auto"], { unattended: true }).catch(() => "");
          const base = (await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
          const branch = (await git(dir, ["branch", "--show-current"])).trim();
          const dirty = (await git(dir, ["status", "--porcelain"])).trim() !== "";
          // 다른 브랜치에서 작업 중이거나 고친 것이 있으면 받기만 하고 작업 트리는 그대로 둔다
          if (base && branch === base && !dirty) await git(dir, ["merge", "--ff-only", "--quiet", `origin/${base}`], { unattended: true });
          this.update(repo, { fetchedAt: new Date().toISOString(), error: undefined });
        } catch (error) {
          this.update(repo, { error: (error as Error).message });
          console.log(`[repos] refresh ${repo} failed: ${(error as Error).message}`);
        } finally {
          this.pending.delete(repo);
        }
      });
    }
  }

  // 클론과 최신화는 한 번에 하나씩(네트워크와 디스크를 한꺼번에 쓰지 않게)
  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task, task);
  }

  private update(repo: string, patch: Partial<Entry>) {
    const entry = (this.entries[repo] ??= { hits: 0, lastSeen: new Date().toISOString() });
    Object.assign(entry, patch);
    for (const key of Object.keys(patch) as (keyof Entry)[]) if (patch[key] === undefined) delete entry[key];
    this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ repos: this.entries }, null, 2)}\n`);
    } catch (error) {
      console.log(`[repos] save failed: ${(error as Error).message}`);
    }
  }
}

// 클론할 자리 후보: ~/Repository/REPO, 그 이름이 차 있으면 ~/Repository/OWNER-REPO
function candidates(root: string, repo: string) {
  const [owner, name] = repo.split("/");
  return [join(root, name), join(root, `${owner}-${name}`)];
}

// 폴더의 origin 원격이 가리키는 GitHub 저장소(owner/name). git 을 띄우지 않고 .git/config 를 읽는다.
function originOf(dir: string): string | null {
  try {
    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    const url = /^\s*url\s*=\s*(\S+)/m.exec(section)?.[1];
    return url ? parseRemoteUrl(url) : null;
  } catch {
    return null;
  }
}

// owner/name 둘 다 점으로 시작하지 않는 이름만(.. 로 폴더 밖을 가리키지 않게). "-" 로 시작하는 owner 는 gh repo clone 이 옵션으로 읽으니 받지 않는다.
function validRepo(repo: string) {
  const parts = repo.split("/");
  return parts.length === 2 && !repo.startsWith("-") && parts.every((p) => /^[\w-][\w.-]*$/.test(p));
}
