import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { relayHttp } from "../net/relay";
import { isRelayTarget } from "../net/upload";
import { client } from "../state/app";
import { spacing, useColors } from "../theme/theme";
import { Text } from "./Text";

const IDLE_TIMEOUT_MS = 30_000;
const BINARY_SLICE = 8192;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += BINARY_SLICE) binary += String.fromCharCode(...bytes.subarray(at, at + BINARY_SLICE));
  return btoa(binary);
}

function playerDocument(background: string, text: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;background:${background}}video{display:none;width:100vw;height:100dvh;object-fit:contain;background:${background}}p{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;margin:0;font:15px system-ui,sans-serif;color:${text}}</style><p id="status">Loading</p><video id="video" controls autoplay playsinline></video><script>var parts=[],got=0,total=0,type="video/mp4";function begin(size,mime){total=size;type=mime}function part(encoded){var binary=atob(encoded),bytes=new Uint8Array(binary.length);for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);parts.push(bytes);got+=bytes.length;document.getElementById("status").textContent=total?"Loading "+Math.floor(got*100/total)+"%":"Loading"}function finish(){var video=document.getElementById("video");video.src=URL.createObjectURL(new Blob(parts,{type:type}));parts=[];document.getElementById("status").remove();video.style.display="block"}</script>`;
}

export function RelayVideoPlayer({ path }: RelayVideoPlayerProps) {
  const colors = useColors();
  const web = useRef<WebPage | null>(null);
  const transfer = useRef<AbortController | null>(null);
  const [error, setError] = useState<string>();
  const source = useMemo(() => ({ html: playerDocument(colors.surfaceBase, colors.textMuted), baseUrl: "about:blank" }), [colors.surfaceBase, colors.textMuted]);
  useEffect(() => () => transfer.current?.abort(), []);

  const onLoadEnd = () => {
    if (transfer.current) return;
    const target = client.imageUploadTarget();
    if (!target || !isRelayTarget(target)) return setError("Connect to your Mac to play this video.");
    const controller = new AbortController();
    transfer.current = controller;
    const run = (script: string) => web.current?.injectJavaScript(`${script};true;`);
    let sending = false;
    relayHttp(target.relay, { method: "GET", path, headers: {} }, {
      signal: controller.signal,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      onHead: (head) => {
        sending = head.status === 200;
        if (sending) run(`begin(${Number(head.headers["content-length"]) || 0},${JSON.stringify(head.headers["content-type"] ?? "video/mp4")})`);
      },
      onBody: (chunk) => {
        if (sending) run(`part("${toBase64(chunk)}")`);
      },
    }).then(() => {
      if (!sending) throw new Error("Your Mac could not send this video.");
      run("finish()");
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load this video.");
    });
  };

  if (error) return <View style={styles.center}><Text color="textMuted">{error}</Text></View>;
  return <WebView ref={(view: WebPage | null) => { web.current = view; }} source={source} javaScriptEnabled scrollEnabled={false} onLoadEnd={onLoadEnd}
    containerStyle={{ backgroundColor: colors.surfaceBase }} style={{ backgroundColor: colors.surfaceBase }}
    mediaPlaybackRequiresUserAction={false} allowsInlineMediaPlayback allowsFullscreenVideo forceDarkOn={false} originWhitelist={["*"]}
    onShouldStartLoadWithRequest={(request) => request.url === "about:blank"} onOpenWindow={() => {}}
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} domStorageEnabled={false} geolocationEnabled={false} incognito />;
}

type RelayVideoPlayerProps = { path: string };
type WebPage = { injectJavaScript(script: string): void };

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl },
});
