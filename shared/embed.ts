export type EmbedTheme = "dark" | "light";

export type EmbedToHost =
  | { type: "agent-nav:ready" }
  | { type: "agent-nav:session"; agentId: string }
  | { type: "agent-nav:openFile"; file: string; line?: number; column?: number }
  | { type: "agent-nav:openDiff"; agentId: string; file: string }
  | { type: "agent-nav:openChanges"; agentId: string; file?: string }
  | { type: "agent-nav:openExternal"; url: string }
  | { type: "agent-nav:openPr"; url: string };

export type EmbedFromHost =
  | { type: "agent-nav:hello"; theme: EmbedTheme }
  | { type: "agent-nav:theme"; theme: EmbedTheme }
  | { type: "agent-nav:attach"; file: string; startLine: number; endLine: number; text: string }
  | { type: "agent-nav:focus" }
  | { type: "agent-nav:colors"; colors: EmbedColors };

export const EMBED_PREFIX = "agent-nav:";

export function isHostOrigin(origin: string) {
  if (origin.startsWith("vscode-webview://")) return true;
  try {
    return new URL(origin).hostname.endsWith(".vscode-cdn.net");
  } catch {
    return false;
  }
}

export const EMBED_COLORS = {
  editorBackground: { vscode: "--vscode-editor-background", tokens: ["--pane-bg"] },
  foreground: { vscode: "--vscode-foreground", tokens: ["--fg"] },
  descriptionForeground: { vscode: "--vscode-descriptionForeground", tokens: ["--fg-muted"] },
  inputBackground: { vscode: "--vscode-input-background", tokens: ["--input-bg"] },
  inputBorder: { vscode: "--vscode-input-border", tokens: ["--input-border"] },
  focusBorder: { vscode: "--vscode-focusBorder", tokens: ["--focus-border"] },
  buttonBackground: { vscode: "--vscode-button-background", tokens: ["--accent"] },
  buttonForeground: { vscode: "--vscode-button-foreground", tokens: ["--accent-fg"] },
  linkForeground: { vscode: "--vscode-textLink-foreground", tokens: ["--accent-text"] },
  widgetBackground: { vscode: "--vscode-editorWidget-background", tokens: ["--surface-overlay"] },
  listHoverBackground: { vscode: "--vscode-list-hoverBackground", tokens: ["--surface-hover"] },
  listSelectionBackground: { vscode: "--vscode-list-inactiveSelectionBackground", tokens: ["--surface-selected"] },
  requestBackground: { vscode: "--vscode-chat-requestBackground", tokens: ["--chat-user-bg"] },
} as const;

export type EmbedColorRole = keyof typeof EMBED_COLORS;
export type EmbedColors = Partial<Record<EmbedColorRole, string>>;

export function isCssColor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9a-z.,%\s/-]+\)|[a-z]+)$/i.test(value.trim());
}

type StyleTarget = { style: { setProperty(name: string, value: string): void; removeProperty(name: string): string } };

export function applyHostColors(root: StyleTarget, colors: EmbedColors) {
  const accentVanishes = !!colors.buttonBackground && colors.buttonBackground.trim().toLowerCase() === colors.editorBackground?.trim().toLowerCase();
  for (const [role, { tokens }] of Object.entries(EMBED_COLORS)) {
    const value = role === "buttonBackground" && accentVanishes ? undefined : (colors as Record<string, unknown>)[role];
    for (const token of tokens) {
      if (isCssColor(value)) root.style.setProperty(token, value.trim());
      else root.style.removeProperty(token);
    }
  }
}
