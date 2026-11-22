#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || true)"
  [ -n "$JAVA_HOME" ] || JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  export JAVA_HOME
fi
PATH="$JAVA_HOME/bin:$PATH"
ABIS="${ABIS:-arm64-v8a}"

SIGN_DIR=".signing"
KEYSTORE="$SIGN_DIR/lodestar-release.jks"
umask 077
mkdir -p "$SIGN_DIR"
if [ ! -f "$KEYSTORE" ]; then
  PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storetype PKCS12 -alias lodestar -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" -dname "CN=Lodestar, O=Lodestar, C=KR"
  printf '%s\n' "$PASSWORD" > "$SIGN_DIR/password.txt"
  chmod 600 "$SIGN_DIR/password.txt" "$KEYSTORE"
fi
export ORG_GRADLE_PROJECT_LODESTAR_KEYSTORE="$PWD/$KEYSTORE"
export ORG_GRADLE_PROJECT_LODESTAR_KEYSTORE_PASSWORD="$(cat "$SIGN_DIR/password.txt")"
export ORG_GRADLE_PROJECT_LODESTAR_KEY_ALIAS=lodestar
export ORG_GRADLE_PROJECT_LODESTAR_KEY_PASSWORD="$ORG_GRADLE_PROJECT_LODESTAR_KEYSTORE_PASSWORD"

CI=1 npx expo prebuild --platform android --clean --no-install
( cd android && NODE_ENV=production ./gradlew assembleRelease --no-daemon \
    '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1536m' \
    '-Pkotlin.daemon.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=1g' \
    -PreactNativeArchitectures="$ABIS" )

mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/lodestar-android.apk
ls -l dist/lodestar-android.apk
shasum -a 256 dist/lodestar-android.apk
