import { externalOpenUrl, slackAppUrl } from "../shared/slackLink";

const TEAM = "T0123ABCD";
const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (actual: unknown, wanted: unknown) => {
  if (actual !== wanted) throw new Error(`got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  return String(actual);
};

test("message permalink becomes slack://channel with message ts", () =>
  expect(slackAppUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", TEAM), "slack://channel?team=T0123ABCD&id=C06ABCDEF&message=1791974742.663289"));

test("thread reply keeps thread_ts", () =>
  expect(
    slackAppUrl("https://example.slack.com/archives/C06ABCDEF/p1791974800123456?thread_ts=1791974742.663289&cid=C06ABCDEF", TEAM),
    "slack://channel?team=T0123ABCD&id=C06ABCDEF&message=1791974800.123456&thread_ts=1791974742.663289",
  ));

test("malformed thread_ts is dropped", () =>
  expect(slackAppUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289?thread_ts=abc", TEAM), "slack://channel?team=T0123ABCD&id=C06ABCDEF&message=1791974742.663289"));

test("DM and private channel ids work, enterprise host works", () =>
  expect(slackAppUrl("https://example.enterprise.slack.com/archives/D06ABCDEF/p1791974742663289", TEAM), "slack://channel?team=T0123ABCD&id=D06ABCDEF&message=1791974742.663289"));

test("slack links that are not archives messages stay null", () =>
  expect(
    [
      "https://example.slack.com/archives/C06ABCDEF",
      "https://example.slack.com/team/U06ABCDEF",
      "https://app.slack.com/client/T0123ABCD/C06ABCDEF",
      "https://example.slack.com/archives/C06ABCDEF/p123",
      "https://example.slack.com/files/U06ABCDEF/F06ABCDEF/a.png",
    ]
      .map((url) => slackAppUrl(url, TEAM))
      .join(","),
    ",,,,",
  ));

test("other domains and schemes stay null", () =>
  expect(
    [
      "https://example.com/archives/C06ABCDEF/p1791974742663289",
      "https://slack.com/archives/C06ABCDEF/p1791974742663289",
      "https://evilslack.com/archives/C06ABCDEF/p1791974742663289",
      "https://example.slack.com.evil.com/archives/C06ABCDEF/p1791974742663289",
      "http://example.slack.com/archives/C06ABCDEF/p1791974742663289",
      "not a url",
    ]
      .map((url) => slackAppUrl(url, TEAM))
      .join(","),
    ",,,,,",
  ));

test("no workspace id means no slack:// link", () => expect(slackAppUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", ""), null));

test("externalOpenUrl: app target converts", () =>
  expect(externalOpenUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", { slackLinkTarget: "app", slackTeamId: ` ${TEAM} ` }), "slack://channel?team=T0123ABCD&id=C06ABCDEF&message=1791974742.663289"));

test("externalOpenUrl: missing target defaults to app", () =>
  expect(externalOpenUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", { slackTeamId: TEAM }), "slack://channel?team=T0123ABCD&id=C06ABCDEF&message=1791974742.663289"));

test("externalOpenUrl: browser target keeps the https link", () =>
  expect(externalOpenUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", { slackLinkTarget: "browser", slackTeamId: TEAM }), "https://example.slack.com/archives/C06ABCDEF/p1791974742663289"));

test("externalOpenUrl: app target without workspace id falls back to the https link", () =>
  expect(externalOpenUrl("https://example.slack.com/archives/C06ABCDEF/p1791974742663289", { slackLinkTarget: "app", slackTeamId: "" }), "https://example.slack.com/archives/C06ABCDEF/p1791974742663289"));

test("externalOpenUrl: non-slack links are untouched", () => expect(externalOpenUrl("https://github.com/a/b", { slackLinkTarget: "app", slackTeamId: TEAM }), "https://github.com/a/b"));

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
