import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { version as INSTALLED_VERSION } from "../package.json";
import { LATEST_RELEASE_API, releaseFromApi, type ReleaseState } from "../shared/release";
import { HOME } from "./store";

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

  start() {
    this.arm(false);
  }

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
    } finally {
      this.checking = false;
    }
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
