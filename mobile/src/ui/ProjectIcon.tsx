import { Image } from "react-native";
import { useColors } from "../theme/theme";

const marks = {
  folder: require("../../assets/project-marks/folder.png"),
  worktree: require("../../assets/project-marks/worktree.png"),
  pinned: require("../../assets/project-marks/pinned.png"),
  archive: require("../../assets/project-marks/archive.png"),
  chats: require("../../assets/project-marks/chats.png"),
  claude: require("../../assets/project-marks/claude.png"),
  codex: require("../../assets/project-marks/codex.png"),
};

export type ProjectMark = "folder" | "worktree" | "pinned" | "archive" | "chats";

export function ProjectIcon({ mark = "folder", size = 18, strong = false }: { mark?: keyof typeof marks; size?: number; strong?: boolean }) {
  const colors = useColors();
  return <Image accessible={false} importantForAccessibility="no" source={marks[mark]} resizeMode="contain"
    style={{ width: size, height: size, tintColor: strong ? colors.textStrong : colors.textMuted }} />;
}
