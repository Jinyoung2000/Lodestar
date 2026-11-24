#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const STATE = process.env.FAKE_SECURITY_STATE || "/tmp/fake-security.json";
const items = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(items));
const keyOf = (service, account) => `${service}\u0000${account}`;
const flag = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

function words(line) {
  const out = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === "\\" && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

const args = process.argv.slice(2);
if (process.env.FAKE_SECURITY_FAIL === "1") {
  process.stderr.write("security: SecKeychainItemCreateFromContent: User interaction is not allowed.\n");
  process.exit(36);
}
if (args[0] === "-i") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const parts = words(line);
    if (parts[0] !== "add-generic-password") return process.stderr.write(`unsupported: ${parts[0]}\n`);
    items[keyOf(flag(parts, "-s"), flag(parts, "-a"))] = flag(parts, "-w");
    save();
  });
} else if (args[0] === "find-generic-password") {
  const value = items[keyOf(flag(args, "-s"), flag(args, "-a"))];
  if (value === undefined) {
    process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n");
    process.exit(44);
  }
  process.stdout.write(`${value}\n`);
} else if (args[0] === "delete-generic-password") {
  const key = keyOf(flag(args, "-s"), flag(args, "-a"));
  if (!(key in items)) process.exit(44);
  delete items[key];
  save();
} else {
  process.stderr.write(`unsupported: ${args.join(" ")}\n`);
  process.exit(2);
}
