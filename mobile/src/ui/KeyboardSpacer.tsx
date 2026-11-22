import { useEffect, useRef } from "react";
import { Animated, Easing, Keyboard, Platform, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function KeyboardSpacer() {
  const insets = useSafeAreaInsets();
  const height = useRef(new Animated.Value(insets.bottom)).current;
  useEffect(() => {
    const move = (to: number, duration: number) => Animated.timing(height, { toValue: to, duration, easing: Easing.bezier(0.17, 0.59, 0.4, 0.77), useNativeDriver: false }).start();
    const show = (e: KeyboardEvent) => move(Platform.OS === "android" ? e.endCoordinates.height + insets.bottom : Math.max(e.endCoordinates.height, insets.bottom), e.duration || (Platform.OS === "android" ? 120 : 250));
    const hide = (e: KeyboardEvent) => move(insets.bottom, e.duration || (Platform.OS === "android" ? 120 : 250));
    const subs =
      Platform.OS === "android"
        ? [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)]
        : [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", show), Keyboard.addListener("keyboardWillHide", hide)];
    return () => subs.forEach((s) => s.remove());
  }, [height, insets.bottom]);
  return <Animated.View style={{ height }} />;
}
