// MCP tool_result 의 content (문자열이거나 [{type:"text", text}] 배열)를 글 하나로 합친다.
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")).join("");
}
