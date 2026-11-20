import { buildManualPairing, buildPairingUri } from "../../shared/mobile";
import { makeOffer } from "../../server/mobileAccess";
import { DEFAULT_PORT, isLocalNetworkHost, parseFields, parsePairing } from "../src/logic/pairing";
import { expect, run, test } from "./harness";

test("QR 주소: 호스트 여럿, 포트, 코드, 이름을 읽는다", () => {
  const info = parsePairing("lodestar://pair?v=1&h=192.168.0.5%2C100.64.0.9&p=7789&c=ABCD2345&n=Alex%27s+Mac");
  expect(!!info && info.hosts.join() === "192.168.0.5,100.64.0.9" && info.port === 7789 && info.code === "ABCD2345" && info.name === "Alex's Mac", JSON.stringify(info));
  return "ok";
});

test("데몬이 만드는 주소와 수동 문자열을 앱이 그대로 읽는다(양쪽 모양 대조)", () => {
  const offer = makeOffer({ code: "KMNP2389", expiresAt: 1 }, [{ address: "192.168.0.10", iface: "en0", kind: "lan" }, { address: "100.101.102.103", iface: "utun4", kind: "tailscale" }], 7789, "Alex's MacBook");
  const fromUri = parsePairing(offer.uri);
  expect(!!fromUri && fromUri.hosts.join() === "192.168.0.10,100.101.102.103" && fromUri.code === "KMNP2389" && fromUri.name === "Alex's MacBook", JSON.stringify(fromUri));
  const fromManual = parsePairing(offer.manual);
  expect(!!fromManual && fromManual.hosts[0] === "192.168.0.10" && fromManual.port === 7789 && fromManual.code === "KMNP2389", JSON.stringify(fromManual));
  expect(buildManualPairing("1.2.3.4", 7789, "ABCD2345") === "1.2.3.4:7789 ABCD-2345", "manual builder");
  expect(parsePairing(buildPairingUri({ hosts: ["a.local"], port: 1234, code: "ABCD2345", name: "x y" }))?.name === "x y", "name with space");
  return offer.manual;
});

test("수동 입력: 공백, #, 소문자, 하이픈, 포트 생략을 받는다", () => {
  expect(parsePairing("192.168.0.5:7789 abcd-2345")?.code === "ABCD2345", "lowercase hyphen");
  expect(parsePairing("192.168.0.5:7789#ABCD2345")?.port === 7789, "hash");
  expect(parsePairing("  mac.local ABCD2345  ")?.port === DEFAULT_PORT, "default port");
  expect(parseFields("192.168.0.5:7789", "abcd 2345") === null, "space inside the code is not a code");
  expect(parseFields("192.168.0.5:7789", "ABCD-2345")?.code === "ABCD2345", "fields");
  return "ok";
});

test("틀린 입력은 null: 짧은 코드, 헷갈리는 글자, 잘못된 포트와 호스트", () => {
  for (const bad of ["", "hello", "192.168.0.5:7789 ABC", "192.168.0.5:7789 ABCD-23O5", "192.168.0.5:99999 ABCD2345", "192.168.0.5:0 ABCD2345", "bad host ABCD2345 extra", "lodestar://pair", "lodestar://pair?h=&p=1&c=ABCD2345", "lodestar://pair?h=a&p=1&c=SHORT", "lodestar://pair?h=a b&p=1&c=ABCD2345", "http://192.168.0.5:7789"]) {
    expect(parsePairing(bad) === null, `should reject ${JSON.stringify(bad)}`);
  }
  return "ok";
});

test("공인 주소는 거른다: 사설 대역, Tailscale, .local 만 붙는다", () => {
  for (const ok of ["192.168.0.5", "10.0.2.2", "172.16.0.1", "172.31.255.255", "100.101.102.103", "127.0.0.1", "169.254.1.1", "mac.local", "Alex-Mac.local", "mac.tail1234.ts.net", "localhost"]) expect(isLocalNetworkHost(ok), `should accept ${ok}`);
  for (const bad of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "100.128.0.1", "100.63.0.1", "300.1.1.1", "example.com", "evil.local.example.com", "10.0.0.1.evil.com"]) expect(!isLocalNetworkHost(bad), `should reject ${bad}`);
  expect(parsePairing("8.8.8.8:7789 ABCD2345") === null, "manual public ip");
  expect(parsePairing("lodestar://pair?h=8.8.8.8%2C192.168.0.5&p=7789&c=ABCD2345")?.hosts.join() === "192.168.0.5", "public host dropped from the list");
  expect(parsePairing("lodestar://pair?h=example.com&p=7789&c=ABCD2345") === null, "only public hosts");
  return "ok";
});

void run();
