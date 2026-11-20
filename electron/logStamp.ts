import { StringDecoder } from "node:string_decoder";

// 데몬 로그(daemon.log)의 줄 앞에 ISO 시각을 붙인다. 시각이 없으면 종료 때 어느 단계에서 시간이 갔는지 순서밖에 알 수 없다.
// 데몬 stdout 은 청크가 줄 중간에서 끊기므로 "줄 시작" 상태를 들고 있다가 글자가 처음 오는 줄에만 붙인다.
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

// 한 줄짜리 메시지(앞뒤 개행 없이)에 시각을 붙여 끝에 개행을 단다.
export function stampLine(message: string, now: () => Date = () => new Date()): string {
  return `${now().toISOString()} ${message}\n`;
}
