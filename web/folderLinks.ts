import { openFolderApi } from "./openFolder";
import { flash } from "./store";
import { S } from "./strings";

export function initFolderLinks() {
  const handle = (event: Event) => {
    const anchor = (event.target as Element | null)?.closest?.<HTMLElement>("[data-folder]");
    if (!anchor?.dataset.folder) return;
    event.preventDefault();
    void openFolderLink(anchor.dataset.folder);
  };
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      handle(event);
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handle(event);
  });
}

async function openFolderLink(dir: string) {
  try {
    await openFolderApi.run({ dir, file: null, startSession: !openFolderApi.shownDirs().includes(dir) });
  } catch (error) {
    flash(S.openFolderLinkFailed((error as Error).message), "error");
  }
}
