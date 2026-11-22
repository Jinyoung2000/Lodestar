import { StringDecoder } from "node:string_decoder";

export class LineStamper {
  private atLineStart = true;
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly now: () => Date = () => new Date()) {}

  feed(chunk: string | Buffer): string {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (!text) return "";
    let out = "";
    const pieces = text.split("\n");
    pieces.forEach((piece, index) => {
      const last = index === pieces.length - 1;
      if (piece.length > 0) {
        if (this.atLineStart) out += `${this.now().toISOString()} `;
        out += piece;
        this.atLineStart = false;
      }
      if (!last) {
        out += "\n";
        this.atLineStart = true;
      }
    });
    return out;
  }
}

export function stampLine(message: string, now: () => Date = () => new Date()): string {
  return `${now().toISOString()} ${message}\n`;
}
