import type { ReactNode } from "react";
import { Image } from "react-native";
import { useAppState } from "../state/app";

export function useWorkspaceIcon(workspaceId: string | null | undefined) {
  return useAppState((state) => (workspaceId ? state.workspaceIcons[workspaceId] ?? null : null));
}

export function WorkspaceIcon({ workspaceId, size = 16, fallback = null }: { workspaceId: string | null | undefined; size?: number; fallback?: ReactNode }) {
  const uri = useWorkspaceIcon(workspaceId);
  if (!uri) return <>{fallback}</>;
  return <Image accessible={false} importantForAccessibility="no" source={{ uri }} resizeMode="cover"
    style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} />;
}
