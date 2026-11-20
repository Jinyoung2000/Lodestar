import { fileIconId, folderIconId, iconUrl, useIconTheme, useScheme } from "./materialIcons";

// 파일 이름으로 고른 Material 아이콘. 이름은 경로여도 된다. 매핑을 읽기 전에는 기본 파일 아이콘.
export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const theme = useIconTheme();
  const scheme = useScheme();
  return <MaterialImage id={theme ? fileIconId(theme, name, scheme) : "file"} size={size} />;
}

export function FolderTypeIcon({ name, open = false, size = 16 }: { name: string; open?: boolean; size?: number }) {
  const theme = useIconTheme();
  const scheme = useScheme();
  return <MaterialImage id={theme ? folderIconId(theme, name, open, scheme) : open ? "folder-open" : "folder"} size={size} />;
}

function MaterialImage({ id, size }: { id: string; size: number }) {
  return <img className="material-icon" src={iconUrl(id)} width={size} height={size} alt="" draggable={false} />;
}
