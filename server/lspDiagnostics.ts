// typescript-go 는 열린 파일의 진단을 push(textDocument/publishDiagnostics)하지 않고 pull(textDocument/diagnostic)로만 준다.
// 브라우저의 lsp-client 6.3.0 은 push 만 처리하므로, 여기서 문서 알림을 보고 대신 pull 해서 publishDiagnostics 알림으로 바꿔 보낸다.

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

  // 브라우저가 서버로 보내는 메시지를 본다.
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

  // initialize 응답이 온 뒤부터 pull 한다. 그 전에 쌓인 문서는 한꺼번에 가져온다.
  start() {
    this.ready = true;
    for (const uri of this.versions.keys()) this.changed.add(uri);
    this.flush();
  }

  // 서버가 workspace/diagnostic/refresh 를 요청하면 열린 문서 전부를 다시 가져온다.
  refreshAll() {
    for (const uri of this.versions.keys()) this.changed.add(uri);
    this.flush();
  }

  // pull 응답이면 처리하고 true.
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

  // 바뀐 문서를 먼저, 그 다음 나머지 열린 문서(프로젝트 안 다른 파일의 진단이 달라질 수 있다)
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
