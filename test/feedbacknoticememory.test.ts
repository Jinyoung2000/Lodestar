import { failureNoticeKey, loadFailureMemory, saveFailureMemory, showFailureNotice, type StorageLike } from "../web/feedbackNoticeMemory";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const memory = (): StorageLike & { raw: Record<string, string> } => {
  const raw: Record<string, string> = {};
  return { raw, getItem: (k) => raw[k] ?? null, setItem: (k, v) => void (raw[k] = v) };
};

const first = failureNoticeKey({ id: "fb1", updatedAt: "2026-10-16T01:00:00Z" });
const retried = failureNoticeKey({ id: "fb1", updatedAt: "2026-10-16T02:00:00Z" });

const storage = memory();
check("an empty storage remembers nothing", loadFailureMemory(storage).length === 0);

const run1 = new Set(loadFailureMemory(storage));
check("first run shows the failure", showFailureNotice(first, run1, new Set()));
saveFailureMemory(storage, [first]);

const run2 = new Set(loadFailureMemory(storage));
check("second run hides a failure shown in the previous run", !showFailureNotice(first, run2, new Set()));
check("a failure that started showing in this run stays visible until closed", showFailureNotice(first, run2, new Set([first])));
check("a new failure of the same feedback after Retry is shown", showFailureNotice(retried, run2, new Set()));
check("a different feedback is shown", showFailureNotice(failureNoticeKey({ id: "fb2", updatedAt: first.split(":")[1] }), run2, new Set()));

check("broken storage content is ignored", loadFailureMemory({ getItem: () => "{not json", setItem: () => {} }).length === 0);
check("non-array content is ignored", loadFailureMemory({ getItem: () => '{"a":1}', setItem: () => {} }).length === 0);
check("a storage that throws does not break saving or loading", (() => {
  const throwing: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  saveFailureMemory(throwing, [first]);
  return loadFailureMemory(throwing).length === 0;
})());
check("missing storage is fine", loadFailureMemory(undefined).length === 0);

const many = Array.from({ length: 300 }, (_, i) => `fb${i}:t`);
const big = memory();
saveFailureMemory(big, many);
const kept = loadFailureMemory(big);
check("only the newest 200 keys are kept", kept.length === 200 && kept[0] === "fb100:t" && kept[199] === "fb299:t", String(kept.length));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
