import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const NONCE = /^[0-9a-f]{32}$/;
const PROOF = /^[0-9a-f]{64}$/;
let nonceSequence = 0;

function encodeAscii(value: string) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function routeNonce() {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const seed = `${Date.now()}:${++nonceSequence}:${Math.random()}`;
  return bytesToHex(sha256(encodeAscii(seed))).slice(0, 32);
}

export function routeHandshake(deviceId: string, token: string) {
  const nonce = routeNonce();
  const key = encodeAscii(bytesToHex(sha256(encodeAscii(token))));
  return {
    request: { routeDeviceId: deviceId, routeNonce: nonce },
    verify({ routeChallenge, routeProof }: Record<string, unknown>) {
      if (typeof routeChallenge !== "string" || !NONCE.test(routeChallenge) || typeof routeProof !== "string" || !PROOF.test(routeProof)) return null;
      const challenge = `${nonce}:${routeChallenge}`;
      const expected = hmac(sha256, key, encodeAscii(`lodestar-route-proof-v1:${challenge}`));
      if (bytesToHex(expected) !== routeProof) return null;
      return { routeAuth: bytesToHex(hmac(sha256, key, encodeAscii(`lodestar-route-auth-v1:${challenge}`))) };
    },
  };
}
