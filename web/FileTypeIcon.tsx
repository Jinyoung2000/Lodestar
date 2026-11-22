import { fileIconId, folderIconId, iconUrl, useIconTheme, useScheme } from "./materialIcons";

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
