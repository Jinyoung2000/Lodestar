export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function csvRows(text: string, limit: number): { rows: string[][]; clipped: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let clipped = false;
  const finishCell = () => {
    if (row.length < 40) row.push(cell);
    else clipped = true;
    cell = "";
  };
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted && ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"' && (quoted || cell === "")) quoted = !quoted;
    else if (!quoted && ch === ",") finishCell();
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      finishCell();
      rows.push(row);
      row = [];
      if (rows.length === limit) return { rows, clipped: clipped || i + 1 < source.length };
    } else cell += ch;
  }
  if (cell || row.length || source.endsWith('"')) { finishCell(); rows.push(row); }
  return { rows, clipped };
}

export function numericColumns(rows: string[][]) {
  const columns = new Set<number>();
  const values = rows.slice(1);
  for (let column = 0; column < Math.max(0, ...rows.map((row) => row.length)); column++) {
    const cells = values.map((row) => row[column]?.trim()).filter(Boolean);
    if (cells.length > 0 && cells.every((cell) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cell!))) columns.add(column);
  }
  return columns;
}

export function spreadsheet(text: string, colors: { surface: string; surfaceBase: string; text: string; textStrong: string; separator: string }) {
  const { rows, clipped } = csvRows(text, 200);
  const numbers = numericColumns(rows);
  const table = rows.map((row, index) => {
    const tag = index === 0 ? "th" : "td";
    return `<tr>${row.map((cell, column) => `<${tag}${numbers.has(column) ? ' class="number"' : ''}>${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;
  }).join("");
  return `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:13px system-ui;background:${colors.surface};color:${colors.text}}table{border-spacing:0;min-width:100%}th,td{text-align:left;padding:10px 12px;border-bottom:0.5px solid ${colors.separator};white-space:pre-wrap;min-width:72px;max-width:320px;overflow-wrap:anywhere}.number{text-align:right;font-variant-numeric:tabular-nums}th{position:sticky;top:0;background:${colors.surfaceBase};color:${colors.textStrong}}p{margin:16px}</style><table>${table}</table>${clipped ? "<p>Preview limited to 200 rows and 40 columns.</p>" : ""}`;
}

export function vectorDocument(text: string, background: string, padding = 0) {
  return `<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:${background}}img{box-sizing:border-box;padding:${padding}px;width:100%;height:100%;object-fit:contain}</style><img alt="Vector graphic" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}">`;
}

export function thumbnailDocument(html: string, width: number, height: number, background: string) {
  const scale = width / 320;
  const source = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">${html}`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src about:; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'"><style>html{color-scheme:light;background:${background}}body{margin:0;overflow:hidden}iframe{color-scheme:light dark;border:0;width:320px;height:${height / scale}px;transform:scale(${scale});transform-origin:top left;display:block}</style><iframe title="Preview thumbnail" sandbox srcdoc="${escapeHtml(source)}"></iframe>`;
}
