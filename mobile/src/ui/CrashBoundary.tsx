import * as Clipboard from "expo-clipboard";
import * as Updates from "expo-updates";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { crashText, describeCrash, recordCrash, type CrashReport } from "../state/crashLog";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Text } from "./Text";

type CrashBoundaryProps = { children: ReactNode };
type CrashBoundaryState = { report: CrashReport | null };

export class CrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  state: CrashBoundaryState = { report: null };

  static getDerivedStateFromError(error: unknown): CrashBoundaryState {
    return { report: describeCrash("render", error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const report = describeCrash("render", error, info.componentStack);
    recordCrash(report);
    this.setState({ report });
  }

  render() {
    const { report } = this.state;
    if (!report) return this.props.children;
    return <CrashScreen report={report} onRetry={() => this.setState({ report: null })} />;
  }
}

export function CrashScreen({ report, onRetry }: { report: CrashReport; onRetry: () => void }) {
  const colors = useColors();
  const reload = () => void Updates.reloadAsync().catch(onRetry);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
        <Text variant="title" color="textStrong" accessibilityRole="header">Lodestar hit an error</Text>
        <Text color="text" selectable>{report.message}</Text>
        <Text variant="caption" color="textMuted">{report.update}</Text>
        <ScrollView style={[styles.stack, { backgroundColor: colors.codeBackground, borderColor: colors.separator }]} contentContainerStyle={styles.stackContent}>
          <Text variant="mono" color="textMuted" selectable>{report.stack}</Text>
        </ScrollView>
        <View style={styles.actions}>
          <Button title="Copy details" flex onPress={() => void Clipboard.setStringAsync(crashText(report))} />
          <Button title="Reload" kind="primary" flex onPress={reload} />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg, gap: spacing.md },
  stack: { flex: 1, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  stackContent: { padding: spacing.md },
  actions: { flexDirection: "row", gap: spacing.sm },
});
