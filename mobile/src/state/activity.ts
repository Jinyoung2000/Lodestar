import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";
import type { Connection } from "./storage";

type SessionActivity = {
  enabled(): boolean;
  start(urls: string[], token: string): Promise<void>;
  stop(): void;
};

const activity = requireOptionalNativeModule<SessionActivity>("LodestarActivity");
export const activitySupported = !!activity && Platform.OS === "android";
export const alertsEnabled = () => activity?.enabled() ?? false;

export function startAlerts(connection: Connection) {
  if (!activity) throw new Error("Install the latest Android build to use session alerts.");
  const urls = connection.hosts.map((host) => `${connection.secure ? "wss" : "ws"}://${host}:${connection.port}/mobile/ws`);
  return activity.start(urls, connection.token);
}

export async function enableAlerts(connection: Connection) {
  if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
    const allowed = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (allowed !== PermissionsAndroid.RESULTS.GRANTED) throw new Error("Allow notifications for Lodestar in Android settings.");
  }
  await startAlerts(connection);
}

export const stopAlerts = () => activity?.stop();
