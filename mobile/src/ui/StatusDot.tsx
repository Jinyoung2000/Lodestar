import { ActivityIndicator, View } from "react-native";
import type { SessionState } from "../logic/agents";
import { useColors } from "../theme/theme";

// 세션 상태 점: 실행 중은 돌아가는 표시, 답 대기는 주황, 오류는 빨강, 안 읽음은 파랑, 그 밖은 비어 있다.
export function StatusDot({ state, size = 12 }: { state: SessionState; size?: number }) {
  const colors = useColors();
  // 작은 점(헤더 부제목 옆)은 돌아가는 표시 대신 색 점으로 보인다
  if (state === "running" && size > 8) return <ActivityIndicator size="small" color={colors.running} style={{ width: size + 4, height: size + 4 }} />;
  const color = state === "running" ? colors.running : state === "waiting" ? colors.warning : state === "error" ? colors.danger : state === "unread" ? colors.unread : null;
  return <View style={{ width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" }}>{color && <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />}</View>;
}
