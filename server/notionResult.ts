export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")).join("");
}
