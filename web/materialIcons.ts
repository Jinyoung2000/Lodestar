import { useSyncExternalStore } from "react";
import { languageIdFor, type LanguageId } from "./languageId";


export type IconTheme = {
  version: string;
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
  folderExpandedOverrides: Record<string, string>;
  light: {
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
    languageIds: Record<string, string>;
    folderNames: Record<string, string>;
    folderExpandedOverrides: Record<string, string>;
  };
};

export type Scheme = "dark" | "light";

const VSCODE_LANGUAGE: Partial<Record<LanguageId, string>> = {
  shell: "shellscript",
  gitignore: "ignore",
};

export function fileIconId(theme: IconTheme, path: string, scheme: Scheme): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const light = scheme === "light" ? theme.light : null;
  const byName = light?.fileNames[name] ?? theme.fileNames[name];
  if (byName) return byName;
  // a.test.ts 의 확장자 후보는 test.ts, ts 순서다. 점 하나만 앞에 있는 .gitignore 류는 gitignore 가 후보다.
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const extension = name.slice(dot + 1);
    const byExtension = light?.fileExtensions[extension] ?? theme.fileExtensions[extension];
    if (byExtension) return byExtension;
  }
  const language = languageIdFor(name);
  if (language) {
    const vscodeId = VSCODE_LANGUAGE[language] ?? language;
    const byLanguage = light?.languageIds[vscodeId] ?? theme.languageIds[vscodeId];
    if (byLanguage) return byLanguage;
  }
  return theme.file;
}

export function folderIconId(theme: IconTheme, name: string, open: boolean, scheme: Scheme): string {
  const key = name.toLowerCase();
  const light = scheme === "light" ? theme.light : null;
  const closed = light?.folderNames[key] ?? theme.folderNames[key];
  if (!closed) return open ? theme.folderExpanded : theme.folder;
  if (!open) return closed;
  const overridden = (light?.folderExpandedOverrides[key] ?? theme.folderExpandedOverrides[key]) as string | undefined;
  return overridden ?? `${closed}-open`;
}

export function iconUrl(id: string): string {
  return `/material-icons/${id}.svg`;
}

// --- 매핑 파일은 처음 쓸 때 읽는다(번들과 별도 청크). 읽는 동안은 기본 아이콘이 보이고 도착하면 바뀐다. ---

let loaded: IconTheme | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadIconTheme(): Promise<void> {
  loading ??= import("./material-icons/theme.json").then((module) => {
    loaded = module.default;
    for (const listener of listeners) listener();
  });
  return loading;
}

export function useIconTheme(): IconTheme | null {
  void loadIconTheme();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => loaded,
  );
}

// <html data-theme> 가 light 인지. 테마를 바꾸면 같이 바뀐다.
export function useScheme(): Scheme {
  return useSyncExternalStore(
    (listener) => {
      const observer = new MutationObserver(listener);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}
