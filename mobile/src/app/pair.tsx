import { Redirect, useLocalSearchParams } from "expo-router";

export default function Pair() {
  const params = useLocalSearchParams<{ h?: string; p?: string; c?: string; n?: string }>();
  const uri = `lodestar://pair?h=${encodeURIComponent(params.h ?? "")}&p=${params.p ?? ""}&c=${params.c ?? ""}&n=${encodeURIComponent(params.n ?? "")}`;
  return <Redirect href={{ pathname: "/connect", params: { uri } }} />;
}
