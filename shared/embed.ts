export type EmbedTheme = "dark" | "light";

// 화면 -> 확장
export type EmbedToHost =
  // 화면이 떴다. 확장이 hello 로 답하면 그 출처로만 메시지를 보낸다.
  | { type: "agent-nav:ready" }
  // 이 화면이 보여 주는 세션. 새 세션 입력창에서 첫 메시지를 보내면 처음으로 id 가 생긴다.
  | { type: "agent-nav:session"; agentId: string }
  | { type: "agent-nav:openFile"; file: string; line?: number; column?: number }
  // file 은 절대 경로. 지금 디스크의 파일과 세션 기준 내용을 나란히 연다.
  | { type: "agent-nav:openDiff"; agentId: string; file: string }
  // 변경 칩. file 이 없으면 확장이 변경 파일 목록에서 고르게 한다.
  | { type: "agent-nav:openChanges"; agentId: string; file?: string }
  | { type: "agent-nav:openExternal"; url: string }
  | { type: "agent-nav:openPr"; url: string };

// 확장 -> 화면
export type EmbedFromHost =
  | { type: "agent-nav:hello"; theme: EmbedTheme }
  | { type: "agent-nav:theme"; theme: EmbedTheme }
  // 에디터 선택 영역. file 은 절대 경로, text 는 선택이 걸친 줄 전체.
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

// 색 값이 CSS 색으로 쓸 수 있는 모양인지(var(), url(), 세미콜론, 중괄호는 거절). 확장이 보낸 값이라 해도 스타일에 그대로 꽂지 않는다.
export function isCssColor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9a-z.,%\s/-]+\)|[a-z]+)$/i.test(value.trim());
}

type StyleTarget = { style: { setProperty(name: string, value: string): void; removeProperty(name: string): string } };

// 받은 색을 토큰에 덮는다. 이번에 오지 않은 역할은 덮었던 값을 지워 기본 토큰으로 돌아간다(다크에서 고대비로 바뀔 때 남지 않게).
export function applyHostColors(root: StyleTarget, colors: EmbedColors) {
  // 고대비 테마는 단추 바탕이 에디터 바탕과 같은 색(테두리로 구분)이라, 그대로 덮으면 보내기 단추가 사라진다. 이때는 기본 강조색을 둔다.
  const accentVanishes = !!colors.buttonBackground && colors.buttonBackground.trim().toLowerCase() === colors.editorBackground?.trim().toLowerCase();
  for (const [role, { tokens }] of Object.entries(EMBED_COLORS)) {
    const value = role === "buttonBackground" && accentVanishes ? undefined : (colors as Record<string, unknown>)[role];
    for (const token of tokens) {
      if (isCssColor(value)) root.style.setProperty(token, value.trim());
      else root.style.removeProperty(token);
    }
  }
}
