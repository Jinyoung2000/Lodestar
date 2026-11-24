package com.utillo.lodestar.activity

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

internal data class RelayTarget(val url: String, val id: String, val key: String, val privateKey: String) {
  val clientUrl get() = "${url.replaceFirst("http", "ws")}/v1/client/$id"
}

internal object X25519 {
  private val P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
  private val A24 = BigInteger.valueOf(121665)
  private val BASE = ByteArray(32).also { it[0] = 9 }

  fun publicKey(privateKey: ByteArray) = multiply(privateKey, BASE)

  fun multiply(scalar: ByteArray, point: ByteArray): ByteArray {
    val k = scalar.copyOf()
    k[0] = (k[0].toInt() and 248).toByte()
    k[31] = ((k[31].toInt() and 127) or 64).toByte()
    val u = decode(point.copyOf().also { it[31] = (it[31].toInt() and 127).toByte() })
    var x2 = BigInteger.ONE
    var z2 = BigInteger.ZERO
    var x3 = u
    var z3 = BigInteger.ONE
    var swapped = 0
    for (t in 254 downTo 0) {
      val bit = (k[t ushr 3].toInt() ushr (t and 7)) and 1
      if (swapped != bit) {
        x2 = x3.also { x3 = x2 }
        z2 = z3.also { z3 = z2 }
      }
      swapped = bit
      val a = x2.add(z2).mod(P)
      val aa = a.multiply(a).mod(P)
      val b = x2.subtract(z2).mod(P)
      val bb = b.multiply(b).mod(P)
      val e = aa.subtract(bb).mod(P)
      val c = x3.add(z3).mod(P)
      val d = x3.subtract(z3).mod(P)
      val da = d.multiply(a).mod(P)
      val cb = c.multiply(b).mod(P)
      x3 = da.add(cb).pow(2).mod(P)
      z3 = u.multiply(da.subtract(cb).pow(2)).mod(P)
      x2 = aa.multiply(bb).mod(P)
      z2 = e.multiply(aa.add(A24.multiply(e))).mod(P)
    }
    if (swapped == 1) {
      x2 = x3
      z2 = z3
    }
    return encode(x2.multiply(z2.modPow(P.subtract(BigInteger.TWO), P)).mod(P))
  }

  private fun decode(littleEndian: ByteArray) = BigInteger(1, littleEndian.reversedArray())

  private fun encode(value: BigInteger): ByteArray {
    val bigEndian = value.toByteArray()
    val out = ByteArray(32)
    for (i in 0 until minOf(32, bigEndian.size)) out[i] = bigEndian[bigEndian.size - 1 - i]
    return out
  }
}

private const val KEY_BYTES = 32
private const val TAG_BYTES = 16
private val EMPTY = ByteArray(0)

private fun sha256(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data)

private fun hmac(key: ByteArray, data: ByteArray) = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

private fun hkdf(chainingKey: ByteArray, input: ByteArray): Pair<ByteArray, ByteArray> {
  val temp = hmac(chainingKey, input)
  val first = hmac(temp, byteArrayOf(1))
  return first to hmac(temp, first + byteArrayOf(2))
}

private fun nonceFor(counter: Long) = ByteArray(12).also { for (i in 0 until 8) it[4 + i] = (counter ushr (8 * i)).toByte() }

private fun aead(mode: Int, key: ByteArray, counter: Long, ad: ByteArray, input: ByteArray): ByteArray {
  val cipher = runCatching { Cipher.getInstance("ChaCha20/Poly1305/NoPadding") }.getOrElse { Cipher.getInstance("ChaCha20-Poly1305") }
  cipher.init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonceFor(counter)))
  cipher.updateAAD(ad)
  return cipher.doFinal(input)
}

private fun sharedSecret(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
  require(publicKey.size == KEY_BYTES) { "bad public key" }
  return X25519.multiply(privateKey, publicKey).also { shared -> require(shared.any { it.toInt() != 0 }) { "bad public key" } }
}

private const val BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

private fun base64UrlBytes(text: String): ByteArray {
  val out = ArrayList<Byte>()
  var buffer = 0
  var bits = 0
  for (char in text) {
    val value = BASE64_URL.indexOf(char)
    require(value >= 0) { "bad relay key" }
    buffer = ((buffer shl 6) or value) and 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.add((buffer ushr bits).toByte())
    }
  }
  return out.toByteArray()
}

private fun hexBytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

internal class RelaySession(private val sendKey: ByteArray, private val receiveKey: ByteArray) {
  private var sent = 0L
  private var received = 0L

  @Synchronized fun seal(plaintext: ByteArray) = aead(Cipher.ENCRYPT_MODE, sendKey, sent++, EMPTY, plaintext)

  @Synchronized fun open(ciphertext: ByteArray) = aead(Cipher.DECRYPT_MODE, receiveKey, received++, EMPTY, ciphertext)
}

internal class RelayHandshake(target: RelayTarget, private val ephemeral: ByteArray = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }) {
  private val staticPrivate = hexBytes(target.privateKey)
  private val remoteStatic = base64UrlBytes(target.key)
  private var hash = "Noise_IK_25519_ChaChaPoly_SHA256".toByteArray()
  private var chainingKey = hash
  private var key: ByteArray? = null
  private var counter = 0L

  init {
    require(staticPrivate.size == KEY_BYTES && remoteStatic.size == KEY_BYTES) { "bad relay keys" }
    mixHash("lodestar-relay-v1:${target.id}".toByteArray())
    mixHash(remoteStatic)
  }

  private fun mixHash(data: ByteArray) {
    hash = sha256(hash + data)
  }

  private fun mixKey(input: ByteArray) {
    val (nextChain, nextKey) = hkdf(chainingKey, input)
    chainingKey = nextChain
    key = nextKey
    counter = 0L
  }

  private fun encryptAndHash(plaintext: ByteArray): ByteArray {
    val ciphertext = key?.let { aead(Cipher.ENCRYPT_MODE, it, counter++, hash, plaintext) } ?: plaintext
    mixHash(ciphertext)
    return ciphertext
  }

  private fun decryptAndHash(ciphertext: ByteArray): ByteArray {
    val plaintext = key?.let { aead(Cipher.DECRYPT_MODE, it, counter++, hash, ciphertext) } ?: ciphertext
    mixHash(ciphertext)
    return plaintext
  }

  fun first(payload: ByteArray): ByteArray {
    val ephemeralPublic = X25519.publicKey(ephemeral)
    mixHash(ephemeralPublic)
    mixKey(sharedSecret(ephemeral, remoteStatic))
    val sealedStatic = encryptAndHash(X25519.publicKey(staticPrivate))
    mixKey(sharedSecret(staticPrivate, remoteStatic))
    return ephemeralPublic + sealedStatic + encryptAndHash(payload)
  }

  fun second(message: ByteArray): Pair<ByteArray, RelaySession> {
    require(message.size >= KEY_BYTES + TAG_BYTES) { "short handshake" }
    val remoteEphemeral = message.copyOfRange(0, KEY_BYTES)
    mixHash(remoteEphemeral)
    mixKey(sharedSecret(ephemeral, remoteEphemeral))
    mixKey(sharedSecret(staticPrivate, remoteEphemeral))
    val payload = decryptAndHash(message.copyOfRange(KEY_BYTES, message.size))
    val (toResponder, toInitiator) = hkdf(chainingKey, EMPTY)
    return payload to RelaySession(toResponder, toInitiator)
  }
}
