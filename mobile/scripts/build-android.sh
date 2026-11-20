#!/bin/sh
# 폰에 설치하는 안드로이드 APK 를 이 Mac 에서 만든다(Expo/EAS 계정과 Google 계정 필요 없음).
# 결과: mobile/dist/lodestar-android.apk (JS 번들이 들어 있어 Metro 없이 혼자 도는 릴리스 빌드)
#   sh scripts/build-android.sh            # arm64-v8a 만(요즘 안드로이드 폰 전부)
#   ABIS=arm64-v8a,armeabi-v7a,x86_64 sh scripts/build-android.sh   # 32비트 폰이나 x86 에뮬레이터까지
# 필요: JDK 17 이상(Android Studio 의 jbr 도 된다), Android SDK(~/Library/Android/sdk), `npm install` 이 끝난 mobile/
# android/ 는 매번 app.json 과 plugins/ 에서 새로 만든다(커밋하지 않는다).
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

# 서명 키: 처음 한 번 만들고 mobile/.signing/ 에 둔다(git 에 안 올라간다). 같은 키로 서명해야 APK 를 지우지 않고 덮어 설치(업데이트)할 수 있다. 잃어버리면 앱을 지우고 다시 설치해야 한다.
SIGN_DIR=".signing"
KEYSTORE="$SIGN_DIR/lodestar-release.jks"
mkdir -p "$SIGN_DIR"
if [ ! -f "$KEYSTORE" ]; then
  PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storetype PKCS12 -alias lodestar -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" -dname "CN=Lodestar, O=Lodestar, C=KR"
  printf '%s\n' "$PASSWORD" > "$SIGN_DIR/password.txt"
  chmod 600 "$SIGN_DIR/password.txt" "$KEYSTORE"
fi
PASSWORD="$(cat "$SIGN_DIR/password.txt")"

CI=1 npx expo prebuild --platform android --clean --no-install
( cd android && NODE_ENV=production ./gradlew assembleRelease \
    -PreactNativeArchitectures="$ABIS" \
    -PLODESTAR_KEYSTORE="$(cd .. && pwd)/$KEYSTORE" -PLODESTAR_KEYSTORE_PASSWORD="$PASSWORD" -PLODESTAR_KEY_ALIAS=lodestar -PLODESTAR_KEY_PASSWORD="$PASSWORD" )

mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/lodestar-android.apk
ls -l dist/lodestar-android.apk
shasum -a 256 dist/lodestar-android.apk
