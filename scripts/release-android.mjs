import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

const mobile = "mobile";
const keystore = join(mobile, ".signing", "lodestar-release.jks");
if (!existsSync(keystore) || !existsSync(join(mobile, ".signing", "password.txt"))) {
  throw new Error(`Missing ${keystore}. Copy mobile/.signing from the checkout that built the installed APKs; a new key would stop phones from upgrading`);
}

run("node", [join(mobile, "scripts", "ota-plan.mjs")]);

const version = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.version;
const apk = `release/Lodestar-${version}-android-arm64.apk`;

run("sh", [join("scripts", "build-android.sh")], { cwd: mobile });
mkdirSync("release", { recursive: true });
copyFileSync(join(mobile, "dist", "lodestar-android.apk"), apk);
run("shasum", ["-a", "256", apk]);
