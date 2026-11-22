import { Redirect, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { StyleSheet, View } from "react-native";
import { useConnection } from "../state/app";
import { useFoldLayout } from "../ui/FoldLayout";
import { SessionsList } from "../ui/SessionsList";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { spacing } from "../theme/theme";
import { Text } from "../ui/Text";

export default function Sessions() {
  const router = useRouter();
  const { connection, bootstrapped } = useConnection();
  const { wide } = useFoldLayout();
  const headerHeight = useHeaderHeight();

  if (!bootstrapped) return <View style={{ flex: 1 }} />;
  if (!connection) return <Redirect href="/connect" />;
  if (!wide) return <SessionsList headerHeight={headerHeight} />;

  return (
    <View style={styles.empty}>
      <Icon name="list.bullet.clipboard" size={28} color="textSubtle" />
      <Text variant="title" maxFontSizeMultiplier={1.3} color="textStrong" style={styles.title}>No session selected</Text>
      <Button title="New session" kind="plain" style={styles.button} onPress={() => router.push("/new")} />
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", paddingTop: 72, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { fontSize: 19 },
  button: { minHeight: 48 },
});
