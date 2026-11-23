import { Redirect, useLocalSearchParams } from "expo-router";

const PAIRING_KEYS = ["v", "h", "p", "c", "n", "r", "i", "k"] as const;

export default function Pair() {
  const params = useLocalSearchParams<Partial<Record<(typeof PAIRING_KEYS)[number], string>>>();
  const query = PAIRING_KEYS.filter((key) => typeof params[key] === "string").map((key) => `${key}=${encodeURIComponent(params[key] ?? "")}`).join("&");
  return <Redirect href={{ pathname: "/connect", params: { uri: `lodestar://pair?${query}` } }} />;
}
