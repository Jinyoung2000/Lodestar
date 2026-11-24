import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../theme/theme";
import { FoldLayoutContext, useFoldLayout } from "./FoldLayout";
import { useSplitDrag } from "./SplitDrag";

export type SplitPanesProps = {
  panes: readonly string[];
  activeId: string;
  onFocus: (id: string) => void;
  renderPane: (id: string, index: number) => ReactNode;
};

export function SplitPanes({ panes, activeId, onFocus, renderPane }: SplitPanesProps) {
  const colors = useColors();
  const layout = useFoldLayout();
  const insets = useSafeAreaInsets();
  const { source } = useSplitDrag();
  const [width, setWidth] = useState(layout.paneWidth);
  const paneWidth = (width - insets.right) / panes.length;
  return <View style={[styles.row, { paddingRight: insets.right }]} onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
    {panes.map((id, index) => (
      <View key={id} onTouchStart={id === activeId ? undefined : () => onFocus(id)}
        style={[styles.pane, index > 0 && { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: colors.separator }, source?.agentId === id && styles.lifted]}>
        <FoldLayoutContext.Provider value={{ ...layout, paneWidth, connectionInRail: layout.connectionInRail || index > 0 }}>
          {renderPane(id, index)}
        </FoldLayoutContext.Provider>
      </View>
    ))}
  </View>;
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  pane: { flex: 1, minWidth: 0 },
  lifted: { opacity: 0.4 },
});
