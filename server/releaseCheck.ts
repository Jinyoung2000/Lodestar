import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { version as INSTALLED_VERSION } from "../package.json";
import { LATEST_RELEASE_API, releaseFromApi, type ReleaseState } from "../shared/release";
import { HOME } from "./store";

// RELEASE: 설정 notifyNewVersion 이 켜져 있을 때만 GitHub 의 최신 릴리스를 하루에 한 번(그리고 켤 때 한 번) 묻는다.
// 자격 증명 없이 일반 User-Agent 로 묻고, 실패(저장소가 비공개라 404, 오프라인, 한도 초과, 이상한 답)는 조용히 넘기며 알고 있던 값을 바꾸지 않는다.
// 꺼져 있으면 요청도 타이머도 없다. 마지막 확인 시각, 알게 된 최신 버전, 닫은 버전은 release-check.json 에 남아 재시작해도 하루 한 번을 지킨다.
// 시험 인스턴스는 AGENT_NAV_RELEASE_URL 로 묻는 주소를 바꾼다.

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

type Saved = { checkedAt: number; latest: { version: string; url: string } | null; dismissed: string | null };

export class ReleaseCheck {
  private saved: Saved;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private macos: string | null = null;

  constructor(
    private readonly options: {
      enabled: () => boolean;
      onChange: (state: ReleaseState) => void;
      file?: string;
      endpoint?: string;
    },
  ) {
    this.saved = this.load();
    if (platform() === "darwin") execFile("sw_vers", ["-productVersion"], { timeout: 2000 }, (error, stdout) => (this.macos = error ? null : stdout.trim() || null));
  }

  private get file() {
    return this.options.file ?? join(HOME, "release-check.json");
  }

  state(): ReleaseState {
    return { installed: INSTALLED_VERSION, macos: this.macos, latest: this.saved.latest, dismissed: this.saved.dismissed };
  }

  // 데몬이 뜰 때. 켜져 있으면 마지막 확인에서 하루가 지났을 때 묻고, 아니면 남은 시간 뒤로 잡는다.
  start() {
    this.arm(false);
  }

  // 설정이 바뀌었을 때. 켜면 바로 한 번 묻고, 끄면 타이머를 걷는다.
  settingChanged() {
    this.arm(true);
  }

  dismiss(version: string): ReleaseState {
    this.saved = { ...this.saved, dismissed: version };
    this.save();
    const next = this.state();
    this.options.onChange(next);
    return next;
  }

  private arm(now: boolean) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.enabled()) return;
    const wait = now ? 0 : Math.max(0, this.saved.checkedAt + DAY_MS - Date.now());
    this.timer = setTimeout(() => void this.check(), wait);
    this.timer.unref();
  }

  private async check() {
    this.timer = null;
    if (this.checking || !this.options.enabled()) return;
    this.checking = true;
    let latest: Saved["latest"] = null;
    try {
      const response = await fetch(this.options.endpoint ?? process.env.AGENT_NAV_RELEASE_URL ?? LATEST_RELEASE_API, {
        headers: { "User-Agent": "Lodestar", Accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) latest = releaseFromApi(await response.json());
    } catch {
      // 조용히 넘긴다
    } finally {
      this.checking = false;
    }
    // 실패해도 시각은 남겨 하루에 한 번을 넘지 않게 한다. 읽은 값이 있을 때만 최신 버전을 바꾼다.
    const changed = latest !== null && (latest.version !== this.saved.latest?.version || latest.url !== this.saved.latest?.url);
    this.saved = { ...this.saved, checkedAt: Date.now(), latest: latest ?? this.saved.latest };
    this.save();
    if (changed) this.options.onChange(this.state());
    this.arm(false);
  }

  private load(): Saved {
    const empty: Saved = { checkedAt: 0, latest: null, dismissed: null };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved>;
      const latest = raw.latest && typeof raw.latest.version === "string" && typeof raw.latest.url === "string" && raw.latest.url.startsWith("https://github.com/") ? { version: raw.latest.version, url: raw.latest.url } : null;
      return { checkedAt: typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : 0, latest, dismissed: typeof raw.dismissed === "string" ? raw.dismissed : null };
    } catch {
      return empty;
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved, null, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      console.error(`[release] could not save ${this.file}: ${(error as Error).message}`);
    }
  }
}
