import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { routesFromAddress, type ConnectionRoute } from "../logic/routes";
import type { PairingInfo } from "../logic/pairing";
import type { RelayEndpoint, RelayTarget } from "../net/relay";
import type { Cache } from "./store";

export type Connection = { routes: ConnectionRoute[]; token: string; deviceId: string; hostName: string; pairedAt: string; relay?: RelayEndpoint };
type SavedConnection = Omit<Connection, "token" | "relay"> & { relay?: RelayTarget };
type LegacyConnection = Omit<SavedConnection, "routes"> & Pick<PairingInfo, "hosts" | "port" | "secure">;

const TOKEN_KEY = "lodestar.token";
const META_KEY = "lodestar.connection";
const RELAY_KEY = "lodestar.relayKey";
const SECRET_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const asyncCache: Cache = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (keys) => AsyncStorage.multiRemove(keys),
};

export async function loadConnection(): Promise<Connection | null> {
  try {
    const [token, meta, relayKey] = await Promise.all([SecureStore.getItemAsync(TOKEN_KEY), AsyncStorage.getItem(META_KEY), SecureStore.getItemAsync(RELAY_KEY)]);
    if (!token || !meta) return null;
    const saved = JSON.parse(meta) as SavedConnection | LegacyConnection;
    if ("routes" in saved) {
      const { relay, ...rest } = saved;
      return { ...rest, token, ...(relay && relayKey ? { relay: { ...relay, privateKey: relayKey } } : {}) };
    }
    const { deviceId, hostName, pairedAt } = saved;
    return { deviceId, hostName, pairedAt, routes: routesFromAddress(saved), token };
  } catch {
    return null;
  }
}

export async function saveConnection(connection: Connection) {
  const { token, relay, ...rest } = connection;
  await SecureStore.setItemAsync(TOKEN_KEY, token, SECRET_OPTIONS);
  if (relay) await SecureStore.setItemAsync(RELAY_KEY, relay.privateKey, SECRET_OPTIONS);
  else await SecureStore.deleteItemAsync(RELAY_KEY).catch(() => {});
  const meta: SavedConnection = { ...rest, ...(relay ? { relay: { url: relay.url, id: relay.id, key: relay.key } } : {}) };
  await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));
}

export async function clearConnection() {
  await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {}), SecureStore.deleteItemAsync(RELAY_KEY).catch(() => {}), AsyncStorage.removeItem(META_KEY)]);
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
