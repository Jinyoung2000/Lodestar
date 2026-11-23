import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const read = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

const identity = /"(Developer ID Application: [^"]+)"/.exec(read("security", ["find-identity", "-v", "-p", "codesigning"]))?.[1];
if (!identity) throw new Error("No Developer ID Application identity in the keychain");

const keyId = process.env.LODESTAR_NOTARY_KEY_ID;
const issuer = process.env.LODESTAR_NOTARY_ISSUER;
const keyPath = process.env.LODESTAR_NOTARY_KEY ?? join(homedir(), ".config", "lodestar", "signing", `AuthKey_${keyId}.p8`);
if (!keyId || !issuer || !existsSync(keyPath)) throw new Error("Set LODESTAR_NOTARY_KEY_ID, LODESTAR_NOTARY_ISSUER and LODESTAR_NOTARY_KEY (App Store Connect API key)");

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const app = "release/mac-arm64/Lodestar.app";
const zip = `release/Lodestar-${version}-mac-arm64.zip`;

run("npm", ["run", "build"]);
rmSync(app, { recursive: true, force: true });
run("npx", ["electron-builder", "--mac", "--dir", `-c.mac.identity=${identity.replace(/^Developer ID Application: /, "")}`], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "true" } });
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

rmSync(zip, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
run("xcrun", ["notarytool", "submit", zip, "--key", keyPath, "--key-id", keyId, "--issuer", issuer, "--wait"]);
run("xcrun", ["stapler", "staple", app]);
rmSync(zip, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
run("shasum", ["-a", "256", zip]);
