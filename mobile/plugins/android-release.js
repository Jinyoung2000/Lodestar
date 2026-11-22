const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require("expo/config-plugins");

function withManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (app) {
      app.$["android:usesCleartextTraffic"] = "true";
      app.$["android:allowBackup"] = "false";
    }
    const main = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    main.$["android:screenOrientation"] = "unspecified";
    main.$["android:resizeableActivity"] = "true";
    const changes = new Set((main.$["android:configChanges"] ?? "").split("|").filter(Boolean));
    changes.add("density");
    changes.add("fontScale");
    main.$["android:configChanges"] = [...changes].join("|");
    return mod;
  });
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let text = mod.modResults.contents;
    if (text.includes("LODESTAR_KEYSTORE")) return mod;
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
