export const HISTORY_LIMIT = 100;

export class SearchHistory {
  private items: string[];
  // items.length 면 맨 끝(기록 밖의 현재 입력)
  private cursor: number;

  constructor(items: readonly string[] = []) {
    this.items = items.filter((item) => item !== "").slice(-HISTORY_LIMIT);
    this.cursor = this.items.length;
  }

  values(): string[] {
    return [...this.items];
  }

  // 같은 값이 이미 있으면 맨 뒤로 옮긴다
  add(value: string) {
    if (value === "") return;
    this.items = [...this.items.filter((item) => item !== value), value].slice(-HISTORY_LIMIT);
    this.cursor = this.items.length;
  }

  // 현재 입력을 기록 끝에 임시로 얹어 두었다가 ↓ 로 돌아올 수 있게 한다(입력 박스의 addIfNotPresent)
  previous(current: string): string | null {
    if (this.items.length === 0) return null;
    if (this.cursor >= this.items.length && current !== "") {
      if (this.items[this.items.length - 1] !== current) this.items = [...this.items, current];
      this.cursor = this.items.length - 1;
    }
    this.cursor = Math.max(0, this.cursor - 1);
    return this.items[this.cursor];
  }

  next(): string | null {
    if (this.cursor >= this.items.length) return null;
    this.cursor += 1;
    return this.cursor >= this.items.length ? "" : this.items[this.cursor];
  }

  // 입력을 직접 고치면 기록 끝으로 돌아간다
  reset() {
    this.cursor = this.items.length;
  }

  hasAny() {
    return this.items.length > 0;
  }
}
