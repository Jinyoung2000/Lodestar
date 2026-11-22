export function notificationPreview(markdown: string, max = NOTIFICATION_PREVIEW_MAX): string | null {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/^(?=[ \t:|-]*[ \t:|-]\|)[ \t:|-]+$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export const NOTIFICATION_PREVIEW_MAX = 160;
