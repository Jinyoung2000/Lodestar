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

const PART_CHARS = 400_000;
const PARTS_HEAD = "@lodestar-parts:";
const partKey = (key: string, index: number) => `${key}#part${index}`;
const partKeys = (key: string, from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, offset) => partKey(key, from + offset));
const savedPartCounts = new Map<string, number>();

function splitForStorage(value: string, size = PART_CHARS): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

async function readHead(key: string): Promise<string | null> {
  const head = await AsyncStorage.getItem(key);
  savedPartCounts.set(key, head?.startsWith(PARTS_HEAD) ? Number(head.slice(PARTS_HEAD.length)) || 0 : 0);
  return head;
}

async function savedPartCount(key: string): Promise<number> {
  const known = savedPartCounts.get(key);
  if (known !== undefined) return known;
  await readHead(key).catch(() => savedPartCounts.set(key, 0));
  return savedPartCounts.get(key) ?? 0;
}

async function readWhole(key: string): Promise<string | null> {
  const head = await readHead(key);
  const count = savedPartCounts.get(key) ?? 0;
  if (head === null || count === 0) return head;
  const parts = await Promise.all(partKeys(key, 0, count).map((part) => AsyncStorage.getItem(part)));
  return parts.every((part): part is string => part !== null) ? parts.join("") : null;
}

export const asyncCache: Cache = {
  async get(key) {
    try {
      return await readWhole(key);
    } catch (error) {
      console.warn(`[cache] dropped unreadable ${key}`, error);
      await AsyncStorage.removeItem(key).catch(() => {});
      savedPartCounts.set(key, 0);
      return null;
    }
  },
  async set(key, value) {
    const before = await savedPartCount(key);
    const parts = value.length > PART_CHARS ? splitForStorage(value) : [];
    if (parts.length === 0) await AsyncStorage.setItem(key, value);
    else await AsyncStorage.multiSet([...parts.map((part, index): [string, string] => [partKey(key, index), part]), [key, `${PARTS_HEAD}${parts.length}`]]);
    savedPartCounts.set(key, parts.length);
    if (before > parts.length) await AsyncStorage.multiRemove(partKeys(key, parts.length, before)).catch(() => {});
  },
  async remove(keys) {
    const counts = await Promise.all(keys.map(savedPartCount));
    await AsyncStorage.multiRemove(keys.flatMap((key, index) => [key, ...partKeys(key, 0, counts[index])]));
    for (const key of keys) savedPartCounts.set(key, 0);
  },
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
