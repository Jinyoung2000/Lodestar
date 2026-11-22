import { modelNameFromId, versionedDisplayName } from "../shared/modelName";

const checks: [string, string, string][] = [
  [versionedDisplayName("Opus", "claude-opus-5-5"), "Opus 5.5", "버전 없는 이름에 id 의 버전을 붙인다"],
  [versionedDisplayName("Fable", "claude-fable-5-1"), "Fable 5.1", "Fable 도 같다"],
  [versionedDisplayName("Opus 5.5", "claude-opus-5-5"), "Opus 5.5", "이미 버전이 있으면 그대로"],
  [versionedDisplayName("Default (recommended)", "claude-opus-5-5"), "Default (recommended)", "계열 이름이 아니면 그대로"],
  [versionedDisplayName("Opus", null), "Opus", "id 를 모르면 그대로"],
  [versionedDisplayName("Sonnet", "claude-opus-5-5"), "Sonnet", "계열이 다르면 그대로"],
  [modelNameFromId("claude-haiku-4-5-20251001") ?? "", "Haiku 4.5", "날짜가 붙은 id"],
];
let failed = 0;
for (const [actual, expected, name] of checks) {
  if (actual !== expected) {
    failed++;
    console.log(`FAIL ${name}: ${actual} !== ${expected}`);
  }
}
if (failed) process.exit(1);
console.log(`modelname: ${checks.length} passed`);
