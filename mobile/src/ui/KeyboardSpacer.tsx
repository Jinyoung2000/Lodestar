import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, AppState, Easing, Keyboard, Platform, TextInput, type KeyboardEvent, type KeyboardMetrics } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const FOCUS_EVENT_GRACE_MS = [50, 250];

function listenForKeyboard(notify: () => void) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const notifyAgainAfterFocusEvent = () => {
    notify();
    for (const delay of FOCUS_EVENT_GRACE_MS) {
      const timer = setTimeout(() => { timers.delete(timer); notify(); }, delay);
      timers.add(timer);
    }
  };
  const show = Keyboard.addListener("keyboardDidShow", notifyAgainAfterFocusEvent);
  const hide = Keyboard.addListener("keyboardDidHide", notify);
  const appState = AppState.addEventListener("change", notify);
  return () => {
    show.remove();
    hide.remove();
    appState.remove();
    timers.forEach(clearTimeout);
  };
}

const MISSED_HIDE_REPORT_DELAY_MS = 1000;
let checkedStaleMetrics: KeyboardMetrics | null = null;

function reportIfHideNeverArrives(metrics: KeyboardMetrics) {
  if (checkedStaleMetrics === metrics) return;
  checkedStaleMetrics = metrics;
  setTimeout(() => {
    if (Keyboard.metrics() !== metrics || TextInput.State.currentlyFocusedInput()) return;
    console.warn("Keyboard reported open with no focused input; treating it as closed", { height: metrics.height, appState: AppState.currentState });
  }, MISSED_HIDE_REPORT_DELAY_MS);
}

function openKeyboard() {
  const metrics = Keyboard.metrics();
  if (!metrics) return undefined;
  if (TextInput.State.currentlyFocusedInput()) return metrics;
  reportIfHideNeverArrives(metrics);
  return undefined;
}

export function useKeyboardTop() {
  return useSyncExternalStore(listenForKeyboard, () => openKeyboard()?.screenY);
}

export function KeyboardSpacer({ keyboardOnly = false }: { keyboardOnly?: boolean }) {
  const insets = useSafeAreaInsets();
  const idleHeight = keyboardOnly ? 0 : insets.bottom;
  const keyboardOpen = useSyncExternalStore(listenForKeyboard, () => openKeyboard() !== undefined);
  const keyboardHeight = keyboardOpen ? Keyboard.metrics()?.height ?? 0 : 0;
  const targetHeight = keyboardHeight === 0 ? idleHeight : Platform.OS === "android"
    ? keyboardHeight + insets.bottom
    : Math.max(keyboardHeight, insets.bottom);
  const height = useRef(new Animated.Value(targetHeight)).current;
  useEffect(() => {
    const move = (to: number, duration: number) => Animated.timing(height, { toValue: to, duration, easing: Easing.bezier(0.17, 0.59, 0.4, 0.77), useNativeDriver: false }).start();
    const show = (e: KeyboardEvent) => move(Platform.OS === "android" ? e.endCoordinates.height + insets.bottom : Math.max(e.endCoordinates.height, insets.bottom), e.duration || (Platform.OS === "android" ? 120 : 250));
    const hide = (e: KeyboardEvent) => move(idleHeight, e.duration || (Platform.OS === "android" ? 120 : 250));
    move(targetHeight, 120);
    const subs =
      Platform.OS === "android"
        ? [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)]
        : [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", show), Keyboard.addListener("keyboardWillHide", hide)];
    return () => {
      subs.forEach((s) => s.remove());
      height.stopAnimation();
    };
  }, [height, idleHeight, insets.bottom, targetHeight]);
  return <Animated.View style={{ height }} />;
}
