import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Easing, Keyboard, Platform, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function listenForKeyboard(notify: () => void) {
  const show = Keyboard.addListener("keyboardDidShow", notify);
  const hide = Keyboard.addListener("keyboardDidHide", notify);
  return () => { show.remove(); hide.remove(); };
}

export function useKeyboardTop() {
  return useSyncExternalStore(listenForKeyboard, () => Keyboard.metrics()?.screenY);
}

export function KeyboardSpacer({ keyboardOnly = false }: { keyboardOnly?: boolean }) {
  const insets = useSafeAreaInsets();
  const idleHeight = keyboardOnly ? 0 : insets.bottom;
  const keyboardHeight = Keyboard.metrics()?.height ?? 0;
  const initialHeight = keyboardHeight === 0 ? idleHeight : Platform.OS === "android"
    ? keyboardHeight + insets.bottom
    : Math.max(keyboardHeight, insets.bottom);
  const height = useRef(new Animated.Value(initialHeight)).current;
  useEffect(() => {
    const move = (to: number, duration: number) => Animated.timing(height, { toValue: to, duration, easing: Easing.bezier(0.17, 0.59, 0.4, 0.77), useNativeDriver: false }).start();
    const show = (e: KeyboardEvent) => move(Platform.OS === "android" ? e.endCoordinates.height + insets.bottom : Math.max(e.endCoordinates.height, insets.bottom), e.duration || (Platform.OS === "android" ? 120 : 250));
    const hide = (e: KeyboardEvent) => move(idleHeight, e.duration || (Platform.OS === "android" ? 120 : 250));
    const subs =
      Platform.OS === "android"
        ? [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)]
        : [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", show), Keyboard.addListener("keyboardWillHide", hide)];
    return () => {
      subs.forEach((s) => s.remove());
      height.stopAnimation();
    };
  }, [height, idleHeight, insets.bottom]);
  return <Animated.View style={{ height }} />;
}
