// 기기에 남기는 것: 장치 토큰은 키체인(SecureStore), 주소와 캐시는 AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Cache } from "./store";

export type Connection = { hosts: string[]; port: number; token: string; deviceId: string; hostName: string; pairedAt: string };

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
    return { ...(JSON.parse(meta) as Omit<Connection, "token">), token };
  } catch {
    return null;
  }
}

export async function saveConnection(connection: Connection) {
  const { token, ...meta } = connection;
  // 잠금이 풀린 뒤 이 기기에서만 읽을 수 있다(백업과 다른 기기로의 이전에서 제외)
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
