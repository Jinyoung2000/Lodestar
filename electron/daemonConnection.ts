import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { daemonSocket, type DaemonEvent, type DaemonState } from "./daemonSocket";

type Options = {
  home: string;
  appRoot: string;
  srcRoot: string;
  logDir: string;
  port: number;
  packaged: boolean;
  version: string;
  onState: (state: DaemonState) => void;
  log: (message: string) => void;
};

export class DaemonConnection {
  private socket: Socket | null = null;
  private pending: Promise<void> | null = null;
  private restartReply: ((result: boolean | "deferred") => void) | null = null;
  private closed = false;
  private replaced = false;
  state: DaemonState;

  constructor(private readonly options: Options) {
    this.state = { state: "restarting", attempt: 0, maxAttempts: 0, port: options.port, pid: null };
  }

  connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.closed = false;
    this.pending = this.attach().then(async () => {
      if (this.socket && !this.socket.destroyed && this.state.state === "stopped") await this.restart();
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }

  restart(): Promise<boolean | "deferred"> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      if (this.closed) return Promise.resolve(false);
      return this.connect().then(() => this.socket !== null && !this.socket.destroyed, () => false);
    }
    if (this.restartReply) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.restartReply?.(false), 2000);
      this.restartReply = (result) => {
        clearTimeout(timeout);
        this.restartReply = null;
        resolve(result);
      };
      socket.write("restart\n");
    });
  }

  private async attach() {
    const { home } = this.options;
    mkdirSync(home, { recursive: true });
    const path = daemonSocket(home);
    if (this.closed || await this.open(path)) return;
    if (this.closed) return;
    await this.waitForOldSupervisor(path);
    this.launch();
    for (let i = 0; i < 80 && !this.closed; i++) {
      await delay(100);
      if (!this.closed && await this.open(path)) return;
      if (i === 10 && !this.closed) this.launch();
    }
    if (!this.closed) throw new Error("Lodestar daemon supervisor did not answer");
  }

  private async waitForOldSupervisor(path: string) {
    if (!this.replaced) return;
    this.replaced = false;
    for (let i = 0; i < 60 && existsSync(path); i++) await delay(100);
  }

  private launch() {
    const { home, appRoot, srcRoot, logDir, port, packaged, log } = this.options;
    mkdirSync(logDir, { recursive: true });
    const output = openSync(join(logDir, "daemon-supervisor.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [join(appRoot, "dist-electron", "daemonSupervisor.mjs"), home, appRoot, srcRoot, logDir], {
        detached: true,
        cwd: appRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_NAV_PORT: String(port), AGENT_NAV_PACKAGED: packaged ? "1" : "", AGENT_NAV_APP_VERSION: this.options.version },
        stdio: ["ignore", output, output],
      });
      child.on("error", (error) => log(`[electron] could not start daemon supervisor: ${error.message}`));
      child.unref();
    } finally {
      closeSync(output);
    }
  }

  private open(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let attached = false;
      const timeout = setTimeout(() => socket.destroy(), 500);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        clearTimeout(timeout);
        if (!attached) return resolve(false);
        if (this.socket !== socket) return;
        this.socket = null;
        this.restartReply?.(false);
        if (this.closed) return;
        this.update({ ...this.state, state: "restarting", pid: null });
        void Promise.resolve(this.pending).then(() => {
          if (!this.closed) return this.connect();
        }).catch((error) => {
          this.options.log(`[electron] daemon supervisor reconnect failed: ${String(error)}`);
          this.update({ ...this.state, state: "stopped" });
        });
      });
      const events = createInterface({ input: socket });
      events.on("error", () => socket.destroy());
      events.on("line", (line) => {
        let event: DaemonEvent | null;
        try {
          event = JSON.parse(line) as DaemonEvent;
        } catch {
          socket.destroy();
          return;
        }
        if (!event || typeof event !== "object") return socket.destroy();
        if ("restart" in event) return this.restartReply?.(event.restart);
        if (event.port !== this.options.port) {
          reject(new Error(`Lodestar data folder is already in use on port ${event.port}`));
          socket.destroy();
          return;
        }
        if (this.closed) return socket.destroy();
        if (!attached && event.version !== this.options.version) {
          this.options.log(`[electron] daemon supervisor from ${event.version ?? "an older app"} does not match app ${this.options.version}, replacing it`);
          this.replaced = true;
          clearTimeout(timeout);
          socket.write("stop\n");
          resolve(false);
          return;
        }
        if (!attached) {
          attached = true;
          this.socket = socket;
          clearTimeout(timeout);
          resolve(true);
        }
        this.update(event);
      });
    });
  }

  private update(state: DaemonState) {
    this.state = state;
    this.options.onState(state);
  }
}
