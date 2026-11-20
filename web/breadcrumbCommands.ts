import { registerEditorCommands } from "./editorCommands";

function lastCrumb(view: { dom: HTMLElement }) {
  const items = view.dom.closest(".editor")?.querySelectorAll<HTMLButtonElement>(".breadcrumbs-item");
  return items?.length ? items[items.length - 1]! : null;
}

registerEditorCommands([
  {
    id: "breadcrumbsFocus",
    title: "Focus Breadcrumbs",
    run: (view) => {
      const item = lastCrumb(view);
      item?.focus();
      return item !== null;
    },
  },
  {
    id: "breadcrumbsFocusAndSelect",
    title: "Focus and Select Breadcrumbs",
    run: (view) => {
      const item = lastCrumb(view);
      item?.focus();
      item?.click();
      return item !== null;
    },
  },
]);
