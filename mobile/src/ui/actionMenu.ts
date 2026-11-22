import { ActionSheetIOS, Alert, Appearance, Platform } from "react-native";

export type ActionChoice = { label: string; onPress: () => void };
export type ActionMenuRequest = { title: string; choices: ActionChoice[] };

let host: ((request: ActionMenuRequest | null) => void) | null = null;

export function registerActionMenuHost(show: ((request: ActionMenuRequest | null) => void) | null) {
  host = show;
}

export function showActionMenu(title: string, choices: ActionChoice[]) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...choices.map((c) => c.label), "Cancel"], cancelButtonIndex: choices.length, userInterfaceStyle: Appearance.getColorScheme() ?? undefined }, (index) => {
      choices[index]?.onPress();
    });
    return;
  }
  if (host) return host({ title, choices });
  Alert.alert(title, undefined, [...choices.map((c) => ({ text: c.label, onPress: c.onPress })), { text: "Cancel", style: "cancel" as const }], { cancelable: true });
}
