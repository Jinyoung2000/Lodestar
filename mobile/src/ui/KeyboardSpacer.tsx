import { useEffect, useRef } from "react";
import { Animated, Easing, Keyboard, Platform, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// 키보드 높이만큼 아래를 비우는 빈칸. 키보드가 없을 때는 홈 인디케이터 영역(safe area)만큼 비운다.
// KeyboardAvoidingView 는 헤더 높이를 따로 넘겨야 해서 화면마다 어긋나기 쉬우므로, 키보드 이벤트의 높이를 직접 따라 움직인다.
export function KeyboardSpacer() {
  const insets = useSafeAreaInsets();
  const height = useRef(new Animated.Value(insets.bottom)).current;
  useEffect(() => {
    const move = (to: number, duration: number) => Animated.timing(height, { toValue: to, duration, easing: Easing.bezier(0.17, 0.59, 0.4, 0.77), useNativeDriver: false }).start();
    const show = (e: KeyboardEvent) => move(Platform.OS === "android" ? e.endCoordinates.height + insets.bottom : Math.max(e.endCoordinates.height, insets.bottom), e.duration || (Platform.OS === "android" ? 120 : 250));
    const hide = (e: KeyboardEvent) => move(insets.bottom, e.duration || (Platform.OS === "android" ? 120 : 250));
    // 안드로이드는 will 이벤트가 없고 did 이벤트만 온다(edge-to-edge 라서 창이 키보드 위로 줄어들지도 않는다). 보고되는 높이에는 내비게이션 바 영역이 빠져 있어서(Android 의 IME 높이 336dp 에 대해 312dp) 아래 여백을 더한다.
    const subs =
      Platform.OS === "android"
        ? [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)]
        : [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", show), Keyboard.addListener("keyboardWillHide", hide)];
    return () => subs.forEach((s) => s.remove());
  }, [height, insets.bottom]);
  return <Animated.View style={{ height }} />;
}
