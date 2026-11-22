import { chromeLikeUserAgent, guestPopupDecision } from "../electron/guestPopup";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (actual: unknown, wanted: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual);
};

const NOTION = "https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef";

test("notion page opening a sized window to google sign-in or to notion: popup", () =>
  expect(
    [
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://www.notion.so/googleauth?x=1", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: "https://app.notion.com/p/0123456789abcdef0123456789abcdef", targetUrl: "https://appleid.apple.com/auth/authorize", disposition: "new-window" }),
    ],
    ["popup", "popup", "popup"],
  ));

test("plain target=_blank links stay links, even to notion pages", () =>
  expect(
    [
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://www.notion.so/Other-" + "a".repeat(32), disposition: "foreground-tab" }),
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://accounts.google.com/", disposition: "background-tab" }),
    ],
    ["link", "link"],
  ));

test("sized windows to other hosts, or from non-notion pages, stay links", () =>
  expect(
    [
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://ads.example.com/x", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "https://accounts.google.com.evil.com/", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: "https://example.com/", targetUrl: "https://accounts.google.com/", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: "https://notion.so.evil.com/", targetUrl: "https://accounts.google.com/", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "http://www.notion.so/x", disposition: "new-window" }),
    ],
    ["link", "link", "link", "link", "link"],
  ));

test("non-http targets and broken urls are denied", () =>
  expect(
    [
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "javascript:alert(1)", disposition: "new-window" }),
      guestPopupDecision({ openerUrl: NOTION, targetUrl: "notion://www.notion.so/x", disposition: "foreground-tab" }),
      guestPopupDecision({ openerUrl: "", targetUrl: "https://accounts.google.com/", disposition: "new-window" }),
    ],
    ["deny", "deny", "deny"],
  ));

test("google sign-in user agent drops the Electron and app tokens", () =>
  expect(
    chromeLikeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) agent-nav/0.1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36"),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  ));

test("a user agent without those tokens is unchanged", () => expect(chromeLikeUserAgent("Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"));

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`.slice(0, 200));
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
