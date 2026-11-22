type Case = { name: string; run: () => Promise<string> | string };
const cases: Case[] = [];

export const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });

export const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, ms = 3000, label = "condition") {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

export async function run() {
  let failed = 0;
  for (const c of cases) {
    try {
      console.log(`ok   ${c.name} (${await c.run()})`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${c.name}: ${(error as Error).message}`);
    }
  }
  console.log(failed ? `${failed} failed` : `${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}
