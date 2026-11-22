import { readFile } from "node:fs/promises";

export type WebBuildWatchOptions = {
  indexFile: () => string;
  onChange: () => void;
  skip?: () => boolean;
  intervalMs?: number;
};

export class WebBuildWatch {
  private seen: string | null = null;
  private candidate: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(private options: WebBuildWatchOptions) {}

  async start() {
    this.seen = await this.read();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 2000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async adopt() {
    const current = await this.read();
    if (current !== null) this.seen = current;
    this.candidate = null;
  }

  private async poll() {
    if (this.reading) return;
    this.reading = true;
    try {
      if (this.options.skip?.()) {
        await this.adopt();
        return;
      }
      const current = await this.read();
      if (current === null || current === this.seen) {
        this.candidate = null;
        return;
      }
      if (this.seen === null || current !== this.candidate) {
        if (this.seen === null) this.seen = current;
        else this.candidate = current;
        return;
      }
      this.seen = current;
      this.candidate = null;
      this.options.onChange();
    } finally {
      this.reading = false;
    }
  }

  private async read() {
    try {
      return await readFile(this.options.indexFile(), "utf8");
    } catch {
      return null;
    }
  }
}
