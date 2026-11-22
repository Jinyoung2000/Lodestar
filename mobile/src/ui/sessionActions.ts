import { useCallback, useState } from "react";
import { Alert } from "react-native";
import type { Agent } from "@shared/protocol";
import { store } from "../state/app";
import { showActionMenu } from "./actionMenu";

export function useSessionActions() {
  const [renaming, setRenaming] = useState<Agent | null>(null);
  const fail = useCallback((error: unknown) => Alert.alert("Could not update the session", error instanceof Error ? error.message : String(error)), []);
  const open = useCallback(
    (agent: Agent) => {
      showActionMenu(agent.title, [
        { label: "Rename…", onPress: () => setRenaming(agent) },
        { label: agent.pinned ? "Unpin" : "Pin", onPress: () => void store.setPinned(agent.id, !agent.pinned).catch(fail) },
        { label: agent.done ? "Mark as not done" : "Mark as done", onPress: () => void store.setDone(agent.id, !agent.done).catch(fail) },
        { label: agent.unread ? "Mark as read" : "Mark as unread", onPress: () => void store.markRead(agent.id, !!agent.unread).catch(fail) },
      ]);
    },
    [fail],
  );
  const submitRename = useCallback(async (title: string) => {
    if (renaming) await store.rename(renaming.id, title);
  }, [renaming]);
  return { open, renaming, submitRename, closeRename: useCallback(() => setRenaming(null), []) };
}
