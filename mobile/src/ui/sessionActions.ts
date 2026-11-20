import { useCallback, useState } from "react";
import { Alert } from "react-native";
import type { Agent } from "@shared/protocol";
import { store } from "../state/app";
import { showActionMenu } from "./actionMenu";

// 세션 하나에 하는 동작 메뉴(목록 길게 누르기, 대화 화면 머리의 ... 단추, 워크스페이스 화면이 같이 쓴다).
// 이름 바꾸기는 입력 창이 필요해서 renaming 에 대상을 두고, 화면이 <RenameDialog initial={renaming?.title ?? null}> 로 띄운다.
// 메뉴 문구는 데스크톱 사이드바와 같다(Pin, Mark as Done, Mark as Unread). done 은 Paseo 의 보관(archive)에 해당한다.
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
