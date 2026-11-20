import { registerEditorCommands } from "./editorCommands";

registerEditorCommands([
  {
    id: "showHover",
    title: "Show or Focus Hover",
    run: (view) => {
      const box = view.coordsAtPos(view.state.selection.main.head);
      if (!box) return false;
      view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { clientX: box.left + 1, clientY: (box.top + box.bottom) / 2, bubbles: true, view: window }));
      return true;
    },
  },
]);
