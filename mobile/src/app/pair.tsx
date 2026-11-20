import { Redirect, useLocalSearchParams } from "expo-router";

// lodestar://pair?... 링크(카메라 앱으로 QR 을 읽었을 때)는 연결 화면으로 넘기고 바로 페어링한다.
export default function Pair() {
  const params = useLocalSearchParams<{ h?: string; p?: string; c?: string; n?: string }>();
  const uri = `lodestar://pair?h=${encodeURIComponent(params.h ?? "")}&p=${params.p ?? ""}&c=${params.c ?? ""}&n=${encodeURIComponent(params.n ?? "")}`;
  return <Redirect href={{ pathname: "/connect", params: { uri } }} />;
}
