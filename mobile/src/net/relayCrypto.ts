import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, type NoisePrimitives } from "./relayNoise.generated";

type ExpoGlobal = { expo?: { uuidv4?: () => string } };

function nativeUuidBytes(): Uint8Array {
  const uuidv4 = (globalThis as unknown as ExpoGlobal).expo?.uuidv4;
  if (!uuidv4) throw new Error("This build cannot create secure keys. Update Lodestar on your phone.");
  const hex = uuidv4().replace(/-/g, "");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function secureRandomBytes(length: number): Uint8Array {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(new Uint8Array(length));
  const uuids = Math.ceil((length * 8) / 122) + 2;
  const seed = concatBytes(...Array.from({ length: uuids }, nativeUuidBytes));
  const out = new Uint8Array(length);
  for (let block = 0; block * 32 < length; block++) out.set(sha256(concatBytes(seed, Uint8Array.of(block))).subarray(0, length - block * 32), block * 32);
  return out;
}

export const phoneNoise: NoisePrimitives = {
  publicKey: (privateKey) => x25519.getPublicKey(privateKey),
  dh: (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey),
  randomBytes: secureRandomBytes,
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  seal: (key, nonce, ad, plaintext) => chacha20poly1305(key, nonce, ad).encrypt(plaintext),
  open: (key, nonce, ad, ciphertext) => chacha20poly1305(key, nonce, ad).decrypt(ciphertext),
};
