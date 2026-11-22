
type Json = Record<string, unknown>;
type Report = { kind?: string; items?: unknown[]; relatedDocuments?: Record<string, Report> };

export const PULL_ID_PREFIX = "lodestar-diag-";

export class DiagnosticPuller {
  private versions = new Map<string, number>();
  private inflight = new Map<string, { id: string; uri: string; version: number }>();
  private byId = new Map<string, { uri: string; version: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private changed = new Set<string>();
  private serial = 0;
  private ready = false;
  private disposed = false;

  constructor(
    private toServer: (message: Json) => void,
    private toClient: (message: Json) => void,
    private debounceMs = 250,
  ) {}

  observe(message: Json) {
    const params = message.params as { textDocument?: { uri?: string; version?: number } } | undefined;
    const uri = params?.textDocument?.uri;
    if (!uri) return;
    switch (message.method) {
      case "textDocument/didOpen":
      case "textDocument/didChange":
        this.versions.set(uri, params?.textDocument?.version ?? 0);
        this.schedule(uri, message.method === "textDocument/didOpen" ? 0 : this.debounceMs);
        return;
      case "textDocument/didSave":
        this.schedule(uri, 0);
        return;
      case "textDocument/didClose":
        this.versions.delete(uri);
        this.cancel(uri);
        this.changed.delete(uri);
        return;
    }
  }

  start() {
    this.ready = true;
    for (const uri of this.versions.keys()) this.changed.add(uri);
    this.flush();
  }

  refreshAll() {
    for (const uri of this.versions.keys()) this.changed.add(uri);
    this.flush();
  }

  handleResponse(message: Json): boolean {
    const id = message.id;
    if (typeof id !== "string" || !id.startsWith(PULL_ID_PREFIX)) return false;
    const request = this.byId.get(id);
    this.byId.delete(id);
    if (!request) return true;
    if (this.inflight.get(request.uri)?.id === id) this.inflight.delete(request.uri);
    if (this.disposed || message.error || this.versions.get(request.uri) !== request.version) return true;
    this.publish(request.uri, request.version, message.result as Report | null);
    return true;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(uri: string, delay: number) {
    this.changed.add(uri);
    if (!this.ready) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush() {
    this.timer = null;
    if (this.disposed || !this.ready) return;
    const order = [...this.changed, ...[...this.versions.keys()].filter((uri) => !this.changed.has(uri))];
    this.changed.clear();
    for (const uri of order) this.pull(uri);
  }

  private pull(uri: string) {
    const version = this.versions.get(uri);
    if (version === undefined) return;
    this.cancel(uri);
    const id = `${PULL_ID_PREFIX}${++this.serial}`;
    this.inflight.set(uri, { id, uri, version });
    this.byId.set(id, { uri, version });
    this.toServer({ jsonrpc: "2.0", id, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
  }

  private cancel(uri: string) {
    const previous = this.inflight.get(uri);
    if (!previous) return;
    this.inflight.delete(uri);
    this.byId.delete(previous.id);
    this.toServer({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: previous.id } });
  }

  private publish(uri: string, version: number | undefined, report: Report | null) {
    if (!report || report.kind !== "full") return;
    this.toClient({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: report.items ?? [] } });
    for (const [related, sub] of Object.entries(report.relatedDocuments ?? {})) {
      if (this.versions.has(related) && related !== uri) this.publish(related, this.versions.get(related), sub);
    }
  }
}
