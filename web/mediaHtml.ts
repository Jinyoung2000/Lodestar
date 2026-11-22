import { localImageTarget } from "../shared/media";

const IMG = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi;

export function hideLocalImages(html: string): string {
  if (!html.includes("<img")) return html;
  return html.replace(IMG, (whole, src: string) => {
    if (!localImageTarget(src.replace(/&amp;/g, "&"))) return whole;
    const alt = /\balt="([^"]*)"/i.exec(whole)?.[1];
    const name = src.slice(src.lastIndexOf("/") + 1);
    const text = (alt || name).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span class="media-local-image" title="${src.replace(/</g, "&lt;").replace(/>/g, "&gt;")}">${text}</span>`;
  });
}
