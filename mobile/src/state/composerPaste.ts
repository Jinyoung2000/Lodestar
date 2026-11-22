import { requireOptionalNativeModule } from "expo";
import type { ClipboardImage } from "expo-clipboard";
import { AppState, Platform } from "react-native";
import type { PickedAsset } from "./attach";

type PasteEvents = {
  pasteStarted: { token: string };
  pasteFinished: { token: string; assets?: PickedAsset[]; failed?: number; full?: boolean };
};

export const composerPaste = Platform.OS === "android" ? requireOptionalNativeModule<{
  bind(tag: number, token: string): Promise<void>;
  unbind(token: string): Promise<void>;
  discard(uri: string): Promise<void>;
  addListener<T extends keyof PasteEvents>(event: T, listener: (event: PasteEvents[T]) => void): { remove(): void };
}>("LodestarComposerPaste") : null;

const legacyClipboard = Platform.OS === "android" && !composerPaste
  ? requireOptionalNativeModule<{ getImageAsync?(options: { format: "jpeg" }): Promise<ClipboardImage | null> }>("ExpoClipboard")
  : null;

export const legacyPasteSupported = typeof legacyClipboard?.getImageAsync === "function";

export function discardPastedImage(uri: string) {
  void composerPaste?.discard(uri).catch((error) => console.warn("Could not delete cached clipboard image", error));
}

let binding = 0;
export function nextPasteBinding() {
  return String(++binding);
}

export function isPasteForeground() {
  return AppState.currentState === "active";
}

export async function readClipboardImage(): Promise<PickedAsset[]> {
  const image = await legacyClipboard?.getImageAsync?.({ format: "jpeg" });
  if (!image) throw new Error("Copy an image first.");
  if (image.data.length > 7_000_000 || image.size.width * image.size.height > 40_000_000) {
    throw new Error("The clipboard image is too large.");
  }
  return [{ uri: image.data, ...image.size }];
}
