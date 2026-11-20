// 안드로이드 릴리스 빌드용 설정(prebuild 마다 android/ 에 다시 적용된다).
// 1. 평문 ws://, http:// 허용: LAN 의 데몬은 TLS 가 없다. 네트워크 보안 설정은 IP 대역(CIDR)을 못 적어서 앱 전체에 허용하고,
//    붙는 주소는 앱 코드(src/logic/pairing.ts 의 isLocalNetworkHost)가 사설 대역과 .local 로만 제한한다.
// 2. 릴리스 서명: android/gradle.properties 나 -P 로 LODESTAR_KEYSTORE 등을 주면 그 키로, 없으면 prebuild 템플릿의 debug 키로 서명한다(scripts/build-android.sh 가 키를 만든다).
const { withAndroidManifest, withAppBuildGradle } = require("expo/config-plugins");

function withManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (app) {
      app.$["android:usesCleartextTraffic"] = "true";
      // 장치 토큰이 클라우드 백업으로 다른 기기에 복원되지 않게 한다(키스토어 키는 기기를 떠나지 않아 복원돼도 못 읽는다)
      app.$["android:allowBackup"] = "false";
    }
    return mod;
  });
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let text = mod.modResults.contents;
    if (text.includes("LODESTAR_KEYSTORE")) return mod;
    // release 서명 설정을 추가한다. 템플릿의 `release { signingConfig signingConfigs.debug ... }` 를 찾아 바꾼다.
    const signing = `        release {
            if (project.hasProperty('LODESTAR_KEYSTORE')) {
                storeFile file(project.property('LODESTAR_KEYSTORE'))
                storePassword project.property('LODESTAR_KEYSTORE_PASSWORD')
                keyAlias project.property('LODESTAR_KEY_ALIAS')
                keyPassword project.property('LODESTAR_KEY_PASSWORD')
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }
`;
    text = text.replace(/(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\n\s*\}\n)/, `$1${signing}`);
    text = text.replace(/(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/, "$1signingConfig signingConfigs.release");
    mod.modResults.contents = text;
    return mod;
  });
}

module.exports = (config) => withReleaseSigning(withManifest(config));
