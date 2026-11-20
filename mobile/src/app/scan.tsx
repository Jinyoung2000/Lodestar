import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { spacing } from "../theme/theme";
import { Button } from "../ui/Button";
import { Text } from "../ui/Text";

// QR 스캔: 첫 인식 결과를 연결 화면에 넘기고 닫는다.
export default function Scan() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);
  if (!permission) return <View style={{ flex: 1 }} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text variant="body" color="textMuted" style={{ textAlign: "center" }}>Lodestar needs the camera to read the pairing QR code.</Text>
        {permission.canAskAgain ? <Button title="Allow camera" kind="primary" onPress={() => void requestPermission()} /> : <Button title="Open Settings" kind="primary" onPress={() => void Linking.openSettings()} />}
        <Button title="Enter the code by hand" kind="plain" onPress={() => router.back()} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          done.current = true;
          router.dismissTo({ pathname: "/connect", params: { scanned: data } });
        }}
      />
      <View style={styles.hint} pointerEvents="none">
        <Text variant="body" style={{ color: "white", textAlign: "center" }}>Point the camera at the QR code in Lodestar Settings</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  hint: { position: "absolute", left: 0, right: 0, bottom: 64, paddingHorizontal: spacing.xl },
});
