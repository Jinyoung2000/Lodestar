import { LAYOUT_PRESETS, type LayoutPreset, type Side } from "./editorLayoutOps";
import { S } from "./strings";


const SIDES: readonly Side[] = ["left", "right", "up", "down"];
const LAYOUT_TITLE: Record<LayoutPreset, string> = Object.fromEntries(LAYOUT_PRESETS.map((p) => [p, `View: Editor Layout - ${S.layoutNames[p]}`])) as Record<LayoutPreset, string>;

export const GROUP_COMMAND_TITLES: Record<string, string> = {
  focusLeftEditorGroup: "View: Focus Left Editor Group",
  focusRightEditorGroup: "View: Focus Right Editor Group",
  focusAboveEditorGroup: "View: Focus Editor Group Above",
  focusBelowEditorGroup: "View: Focus Editor Group Below",
  moveEditorToFirstGroup: "View: Move Editor into First Group",
  moveEditorToLastGroup: "View: Move Editor into Last Group",
  moveEditorGroupLeft: "View: Move Editor Group Left",
  moveEditorGroupRight: "View: Move Editor Group Right",
  moveEditorGroupUp: "View: Move Editor Group Up",
  moveEditorGroupDown: "View: Move Editor Group Down",
  previousEditor: "View: Open Previous Editor",
  nextEditor: "View: Open Next Editor",
  previousEditorInGroup: "View: Open Previous Editor in Group",
  nextEditorInGroup: "View: Open Next Editor in Group",
  moveEditorLeftInGroup: "View: Move Editor Left",
  moveEditorRightInGroup: "View: Move Editor Right",
  lastEditorInGroup: "View: Open Last Editor in Group",
  cycleRecentEditor: "View: Quick Open Previous Recently Used Editor in Group",
  cycleRecentEditorBack: "View: Quick Open Least Recently Used Editor in Group",
  quickOpenRecentEditor: "View: Quick Open Previous Recently Used Editor",
  quickOpenOldestEditor: "View: Quick Open Least Recently Used Editor",
  closeEditorsInGroup: "View: Close All Editors in Group",
  closeUnmodifiedEditors: "View: Close Saved Editors in Group",
  closeOtherEditors: "View: Close Other Editors in Group",
  closeEditorsToTheRight: "View: Close Editors to the Right in Group",
  closeAllEditors: "View: Close All Editors",
  closeAllGroups: "View: Close All Editor Groups",
  closeGroup: "View: Close Editor Group",
  keepEditor: "View: Keep Editor",
  pinEditor: "View: Pin or Unpin Editor",
  toggleMaximizeEditorGroup: "View: Toggle Maximize Editor Group",
  flipEditorGroupLayout: "View: Flip Editor Group Layout",
  resetEditorGroupSizes: "View: Reset Editor Group Sizes",
  joinTwoGroups: "View: Join Editor Group with Next Group",
  joinAllGroups: "View: Join All Editor Groups",
  splitEditorUp: "View: Split Editor Up",
  splitEditorLeft: "View: Split Editor Left",
  reopenClosedEditor: "View: Reopen Closed Editor",
  revealDefinitionAside: "Go to Definition to the Side",
  ...Object.fromEntries(LAYOUT_PRESETS.map((p) => [`editorLayout:${p}`, LAYOUT_TITLE[p]])),
  ...Object.fromEntries(SIDES.map((side) => [`newGroup:${side}`, `View: ${S.newGroupSide[side]}`])),
};

export const GROUP_KEYLESS_COMMANDS = [
  "quickOpenRecentEditor",
  "quickOpenOldestEditor",
  "closeEditorsToTheRight",
  "closeGroup",
  "joinTwoGroups",
  "joinAllGroups",
  "resetEditorGroupSizes",
  "splitEditorUp",
  "splitEditorLeft",
  ...LAYOUT_PRESETS.map((p) => `editorLayout:${p}`),
  ...SIDES.map((side) => `newGroup:${side}`),
];

export function groupCommandTitle(command: string): string | null {
  if (command.startsWith("focusEditorGroup:")) return `View: Focus ${ORDINAL[Number(command.slice("focusEditorGroup:".length))] ?? "Nth"} Editor Group`;
  if (command.startsWith("openEditorAtIndex:")) return `View: Open Editor at Index ${Number(command.slice("openEditorAtIndex:".length)) + 1}`;
  return GROUP_COMMAND_TITLES[command] ?? null;
}

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"];

