import { ActionSheetIOS, Alert, Platform } from "react-native";

// 고르는 메뉴. iOS 는 하단 액션 시트. 안드로이드에는 같은 것이 없다: Alert 는 단추를 3개까지만 그려서(세션 메뉴는 4개) 넘치는 항목이 사라지므로,
// 루트 레이아웃의 <ActionMenuHost> 가 아래에서 올라오는 시트를 그린다. 호스트가 아직 없으면(시험 등) Alert 로 물러난다.
export type ActionChoice = { label: string; onPress: () => void };
export type ActionMenuRequest = { title: string; choices: ActionChoice[] };

let host: ((request: ActionMenuRequest | null) => void) | null = null;

// ActionMenuHost 가 마운트될 때 자신을 등록한다
export function registerActionMenuHost(show: ((request: ActionMenuRequest | null) => void) | null) {
  host = show;
}

export function showActionMenu(title: string, choices: ActionChoice[]) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...choices.map((c) => c.label), "Cancel"], cancelButtonIndex: choices.length }, (index) => {
      choices[index]?.onPress();
    });
    return;
  }
  if (host) return host({ title, choices });
  Alert.alert(title, undefined, [...choices.map((c) => ({ text: c.label, onPress: c.onPress })), { text: "Cancel", style: "cancel" as const }], { cancelable: true });
}
