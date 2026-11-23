import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { routesFromAddress, type ConnectionRoute } from "../logic/routes";
import type { PairingInfo } from "../logic/pairing";
import type { Cache } from "./store";

export type Connection = { routes: ConnectionRoute[]; token: string; deviceId: string; hostName: string; pairedAt: string };
type SavedConnection = Omit<Connection, "token">;
type LegacyConnection = Omit<SavedConnection, "routes"> & Pick<PairingInfo, "hosts" | "port" | "secure">;

const TOKEN_KEY = "lodestar.token";
const META_KEY = "lodestar.connection";

export const asyncCache: Cache = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (keys) => AsyncStorage.multiRemove(keys),
};

export async function loadConnection(): Promise<Connection | null> {
  try {
    const [token, meta] = await Promise.all([SecureStore.getItemAsync(TOKEN_KEY), AsyncStorage.getItem(META_KEY)]);
    if (!token || !meta) return null;
    const saved = JSON.parse(meta) as SavedConnection | LegacyConnection;
    if ("routes" in saved) return { ...saved, token };
    const { deviceId, hostName, pairedAt } = saved;
    return { deviceId, hostName, pairedAt, routes: routesFromAddress(saved), token };
  } catch {
    return null;
  }
}

export async function saveConnection(connection: Connection) {
  const { token, ...meta } = connection;
  await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));
}

export async function clearConnection() {
  await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {}), AsyncStorage.removeItem(META_KEY)]);
}

export async function loadPref<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(`pref:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  void AsyncStorage.setItem(`pref:${key}`, JSON.stringify(value)).catch(() => {});
}
