export const HISTORY_LIMIT = 100;

export class SearchHistory {
  private items: string[];
  private cursor: number;

  constructor(items: readonly string[] = []) {
    this.items = items.filter((item) => item !== "").slice(-HISTORY_LIMIT);
    this.cursor = this.items.length;
  }

  values(): string[] {
    return [...this.items];
  }

  add(value: string) {
    if (value === "") return;
    this.items = [...this.items.filter((item) => item !== value), value].slice(-HISTORY_LIMIT);
    this.cursor = this.items.length;
  }

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

  reset() {
    this.cursor = this.items.length;
  }

  hasAny() {
    return this.items.length > 0;
  }
}
