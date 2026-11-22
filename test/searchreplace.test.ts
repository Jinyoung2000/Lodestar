import assert from "node:assert";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MOBILE_METHODS } from "../shared/mobile";
import type { ServerMessage } from "../shared/protocol";
import { buildReplaceStringWithCasePreserved, REPLACE_MAX_EDITS_PER_FILE, REPLACE_MAX_FILES, ReplacePattern, replacementFor, replacementInContext, type ReplaceEdit, type ReplaceFileRequest, type ReplaceQuery } from "../shared/searchReplace";
import { replaceInWorkspace } from "../server/searchReplace";
import { useTestDaemon } from "./testDaemon";

type Case = { name: string; run: () => void | Promise<void> };
const cases: Case[] = [];
let prefix = "";
const test = (name: string, run: () => void | Promise<void>) => cases.push({ name: prefix + name, run });
const suite = (name: string, body: () => void) => {
  prefix = `${name}: `;
  body();
  prefix = "";
};
const ensureNoDisposablesAreLeakedInTestSuite = () => {};

suite('vscode replace.test.ts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parse replace string', () => {
		const testParse = (input: string, expected: string, expectedHasParameters: boolean) => {
			let actual = new ReplacePattern(input, { pattern: 'somepattern', isRegExp: true });
			assert.strictEqual(expected, actual.pattern);
			assert.strictEqual(expectedHasParameters, actual.hasParameters);

			actual = new ReplacePattern('hello' + input + 'hi', { pattern: 'sonepattern', isRegExp: true });
			assert.strictEqual('hello' + expected + 'hi', actual.pattern);
			assert.strictEqual(expectedHasParameters, actual.hasParameters);
		};

		testParse('hello', 'hello', false);

		testParse('\\thello', '\thello', false);

		testParse('\\nhello', '\nhello', false);

		testParse('\\\\thello', '\\thello', false);

		testParse('\\\\\\thello', '\\\thello', false);

		testParse('\\\\\\\\thello', '\\\\thello', false);

		testParse('hello\\', 'hello\\', false);

		testParse('hello\\x', 'hello\\x', false);

		testParse('hello\\0', 'hello\\0', false);



		testParse('hello$1', 'hello$1', true);
		testParse('hello$2', 'hello$2', true);
		testParse('hello$12', 'hello$12', true);
		testParse('hello$99', 'hello$99', true);
		testParse('hello$99a', 'hello$99a', true);
		testParse('hello$100', 'hello$100', false);
		testParse('hello$100a', 'hello$100a', false);
		testParse('hello$10a0', 'hello$10a0', true);
		testParse('hello$$', 'hello$$', false);
		testParse('hello$$0', 'hello$$0', false);

		testParse('hello$0', 'hello$&', true);
		testParse('hello$02', 'hello$&2', true);

		testParse('hello$`', 'hello$`', true);
		testParse('hello$\'', 'hello$\'', true);
	});

	test('create pattern by passing regExp', () => {
		let expected = /abc/;
		let actual = new ReplacePattern('hello', false, expected).regExp;
		assert.deepStrictEqual(actual, expected);

		expected = /abc/;
		actual = new ReplacePattern('hello', false, /abc/g).regExp;
		assert.deepStrictEqual(actual, expected);

		let testObject = new ReplacePattern('hello$0', false, /abc/g);
		assert.strictEqual(testObject.hasParameters, false);

		testObject = new ReplacePattern('hello$0', true, /abc/g);
		assert.strictEqual(testObject.hasParameters, true);
	});

	test('get replace string if given text is a complete match', () => {
		let testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: true });
		let actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: false });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello', { pattern: '(bla)', isRegExp: true });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello$0', { pattern: '(bla)', isRegExp: true });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hellobla');

		testObject = new ReplacePattern('import * as $1 from \'$2\';', { pattern: 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'\"]([\\w.\\-/]+)\\s*[\'\"]\\s*\\)\\s*', isRegExp: true });
		actual = testObject.getReplaceString('let fs = require(\'fs\')');
		assert.strictEqual(actual, 'import * as fs from \'fs\';');

		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as something from \'fs\';');

		actual = testObject.getReplaceString('let require(\'fs\')');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('import * as $1 from \'$1\';', { pattern: 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'\"]([\\w.\\-/]+)\\s*[\'\"]\\s*\\)\\s*', isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as something from \'something\';');

		testObject = new ReplacePattern('import * as $2 from \'$1\';', { pattern: 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'\"]([\\w.\\-/]+)\\s*[\'\"]\\s*\\)\\s*', isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as fs from \'something\';');

		testObject = new ReplacePattern('import * as $0 from \'$0\';', { pattern: 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'\"]([\\w.\\-/]+)\\s*[\'\"]\\s*\\)\\s*', isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\');');
		assert.strictEqual(actual, 'import * as let something = require(\'fs\') from \'let something = require(\'fs\')\';');

		testObject = new ReplacePattern('import * as $1 from \'$2\';', { pattern: 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'\"]([\\w.\\-/]+)\\s*[\'\"]\\s*\\)\\s*', isRegExp: false });
		actual = testObject.getReplaceString('let fs = require(\'fs\');');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('cat$1', { pattern: 'for(.*)', isRegExp: true });
		actual = testObject.getReplaceString('for ()');
		assert.strictEqual(actual, 'cat ()');
	});

	test('case operations', () => {
		const testObject = new ReplacePattern('a\\u$1l\\u\\l\\U$2M$3n', { pattern: 'a(l)l(good)m(e)n', isRegExp: true });
		const actual = testObject.getReplaceString('allgoodmen');
		assert.strictEqual(actual, 'aLlGoODMen');
	});

	test('case operations - no false positive', () => {
		let testObject = new ReplacePattern('\\left $1', { pattern: '(pattern)', isRegExp: true });
		let actual = testObject.getReplaceString('pattern');
		assert.strictEqual(actual, '\\left pattern');

		testObject = new ReplacePattern('\\hi \\left $1', { pattern: '(pattern)', isRegExp: true });
		actual = testObject.getReplaceString('pattern');
		assert.strictEqual(actual, '\\hi \\left pattern');

		testObject = new ReplacePattern('\\left \\L$1', { pattern: 'PATT(ERN)', isRegExp: true });
		actual = testObject.getReplaceString('PATTERN');
		assert.strictEqual(actual, '\\left ern');
	});

	test('case operations and newline', () => {
		const testObject = new ReplacePattern('$1\n\\U$2', { pattern: '(multi)(line)', isRegExp: true });
		const actual = testObject.getReplaceString('multiline');
		assert.strictEqual(actual, 'multi\nLINE');
	});

	test('get replace string for no matches', () => {
		let testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: true });
		let actual = testObject.getReplaceString('foo');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: false });
		actual = testObject.getReplaceString('foo');
		assert.strictEqual(actual, null);
	});

	test('get replace string if match is sub-string of the text', () => {
		let testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: true });
		let actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: false });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('that', { pattern: 'this(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'that');

		testObject = new ReplacePattern('$1at', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'that');

		testObject = new ReplacePattern('$1e', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'the');

		testObject = new ReplacePattern('$1ere', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'there');

		testObject = new ReplacePattern('$1', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'th');

		testObject = new ReplacePattern('ma$1', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'math');

		testObject = new ReplacePattern('ma$1s', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'maths');

		testObject = new ReplacePattern('ma$1s', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'maths');

		testObject = new ReplacePattern('$0', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'this');

		testObject = new ReplacePattern('$0$1', { pattern: '(th)is(?=.*bla)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'thisth');

		testObject = new ReplacePattern('foo', { pattern: 'bla(?=\\stext$)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'foo');

		testObject = new ReplacePattern('f$1', { pattern: 'b(la)(?=\\stext$)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'fla');

		testObject = new ReplacePattern('f$0', { pattern: 'b(la)(?=\\stext$)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'fbla');

		testObject = new ReplacePattern('$0ah', { pattern: 'b(la)(?=\\stext$)', isRegExp: true });
		actual = testObject.getReplaceString('this is a bla text');
		assert.strictEqual(actual, 'blaah');

		testObject = new ReplacePattern('newrege$1', true, /Testrege(\w*)/);
		actual = testObject.getReplaceString('Testregex', true);
		assert.strictEqual(actual, 'Newregex');

		testObject = new ReplacePattern('newrege$1', true, /TESTREGE(\w*)/);
		actual = testObject.getReplaceString('TESTREGEX', true);
		assert.strictEqual(actual, 'NEWREGEX');

		testObject = new ReplacePattern('new_rege$1', true, /Test_Rege(\w*)/);
		actual = testObject.getReplaceString('Test_Regex', true);
		assert.strictEqual(actual, 'New_Regex');

		testObject = new ReplacePattern('new-rege$1', true, /Test-Rege(\w*)/);
		actual = testObject.getReplaceString('Test-Regex', true);
		assert.strictEqual(actual, 'New-Regex');
	});
});

test("vscode replacePattern.test.ts: buildReplaceStringWithCasePreserved", () => {
  const assertReplace = (target: string[], replaceString: string, expected: string) => assert.strictEqual(buildReplaceStringWithCasePreserved(target, replaceString), expected);
  assertReplace(["abc"], "Def", "def");
  assertReplace(["Abc"], "Def", "Def");
  assertReplace(["ABC"], "Def", "DEF");
  assertReplace(["abc", "Abc"], "Def", "def");
  assertReplace(["Abc", "abc"], "Def", "Def");
  assertReplace(["ABC", "abc"], "Def", "DEF");
  assertReplace(["aBc", "abc"], "Def", "def");
  assertReplace(["AbC"], "Def", "Def");
  assertReplace(["aBC"], "Def", "def");
  assertReplace(["aBc"], "DeF", "deF");
  assertReplace(["Foo-Bar"], "newfoo-newbar", "Newfoo-Newbar");
  assertReplace(["Foo-Bar-Abc"], "newfoo-newbar-newabc", "Newfoo-Newbar-Newabc");
  assertReplace(["Foo-Bar-abc"], "newfoo-newbar", "Newfoo-newbar");
  assertReplace(["foo-Bar"], "newfoo-newbar", "newfoo-Newbar");
  assertReplace(["foo-BAR"], "newfoo-newbar", "newfoo-NEWBAR");
  assertReplace(["foO-BAR"], "NewFoo-NewBar", "newFoo-NEWBAR");
  assertReplace(["Foo_Bar"], "newfoo_newbar", "Newfoo_Newbar");
  assertReplace(["Foo_Bar_Abc"], "newfoo_newbar_newabc", "Newfoo_Newbar_Newabc");
  assertReplace(["Foo_Bar_abc"], "newfoo_newbar", "Newfoo_newbar");
  assertReplace(["Foo_Bar-abc"], "newfoo_newbar-abc", "Newfoo_newbar-abc");
  assertReplace(["foo_Bar"], "newfoo_newbar", "newfoo_Newbar");
  assertReplace(["Foo_BAR"], "newfoo_newbar", "Newfoo_NEWBAR");
  assert.strictEqual(buildReplaceStringWithCasePreserved(null, "x"), "x");
  assert.strictEqual(buildReplaceStringWithCasePreserved([""], "x"), "x");
});

const regexQuery = (pattern: string, patch: Partial<ReplaceQuery> = {}): ReplaceQuery => ({ pattern, isRegex: true, matchCase: true, wholeWord: false, ...patch });
const literalQuery = (pattern: string, patch: Partial<ReplaceQuery> = {}): ReplaceQuery => ({ pattern, isRegex: false, matchCase: true, wholeWord: false, ...patch });

test("replacementFor: $1..$99, $&, $0 와 존재하지 않는 그룹", () => {
  assert.strictEqual(replacementFor("ab", regexQuery("(a)(b)"), "$2$1[$&][$0]", false), "ba[ab][ab]");
  assert.strictEqual(replacementFor("ab", regexQuery("(a)(b)"), "$10", false), "a0");
  assert.strictEqual(replacementFor("ab", regexQuery("(a)(b)"), "$3", false), "$3");
  const many = "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)";
  assert.strictEqual(replacementFor("abcdefghijkl", regexQuery(many), "$12-$1", false), "l-a");
});

test("replacementFor: $& 만 있으면 그대로 두고(VS Code 는 $0 과 $1.. 만 매개변수로 센다), 다른 매개변수와 함께면 일치한 글", () => {
  assert.strictEqual(replacementFor("a", regexQuery("a"), "[$&]", false), "[$&]");
  assert.strictEqual(replacementFor("a", regexQuery("(a)"), "[$&][$1]", false), "[a][a]");
});

test("replacementFor: $$ 는 매개변수가 없으면 그대로, 있으면 $ 한 개 (VS Code 와 같다)", () => {
  assert.strictEqual(replacementFor("a", regexQuery("a"), "$$", false), "$$");
  assert.strictEqual(replacementFor("a", regexQuery("(a)"), "$$-$1", false), "$-a");
});

test("replacementFor: 이름 있는 그룹은 $1 같은 매개변수가 함께 있을 때만 해석된다 (VS Code 의 hasParameters 판정)", () => {
  assert.strictEqual(replacementFor("xy", regexQuery("(?<w>x)(y)"), "$<w>|$2", false), "x|y");
  assert.strictEqual(replacementFor("x", regexQuery("(?<w>x)"), "$<w>", false), "$<w>");
});

test("replacementFor: \\n \\t \\\\ 이스케이프는 정규식일 때만", () => {
  assert.strictEqual(replacementFor("a", regexQuery("a"), "x\\ny\\tz\\\\w\\q", false), "x\ny\tz\\w\\q");
  assert.strictEqual(replacementFor("a", literalQuery("a"), "x\\ny\\tz$1", false), "x\\ny\\tz$1");
});

test("replacementFor: \\u \\U \\l \\L", () => {
  assert.strictEqual(replacementFor("foo-bar", regexQuery("(\\w+)-(\\w+)"), "\\u$1 \\U$2", false), "Foo BAR");
  assert.strictEqual(replacementFor("FOO-BAR", regexQuery("(\\w+)-(\\w+)"), "\\L$1 \\l$2", false), "foo bAR");
  assert.strictEqual(replacementFor("allgoodmen", regexQuery("a(l)l(good)m(e)n"), "a\\u$1l\\u\\l\\U$2M$3n", false), "aLlGoODMen");
});

test("replacementFor: matchCase 와 wholeWord 가 정규식에 반영된다", () => {
  assert.strictEqual(replacementFor("FOO", literalQuery("foo", { matchCase: false }), "bar", false), "bar");
  assert.strictEqual(replacementFor("foo", regexQuery("(foo)", { wholeWord: true }), "$1x", false), "foox");
  assert.strictEqual(replacementFor("FOO", literalQuery("foo"), "bar$1", false), "bar$1");
});

test("replacementFor: preserveCase", () => {
  const q = literalQuery("foo", { matchCase: false });
  assert.strictEqual(replacementFor("Foo", q, "bar", true), "Bar");
  assert.strictEqual(replacementFor("FOO", q, "bar", true), "BAR");
  assert.strictEqual(replacementFor("foo", q, "BAR", true), "bar");
  const snake = literalQuery("foo_bar", { matchCase: false });
  assert.strictEqual(replacementFor("Foo_Bar", snake, "new_name", true), "New_Name");
  const kebab = regexQuery("test-rege(\\w*)", { matchCase: false });
  assert.strictEqual(replacementFor("Test-Regex", kebab, "new-rege$1", true), "New-Regex");
  assert.strictEqual(replacementFor("Foo", q, "bar", false), "bar");
});

test("replacementFor: 여러 줄 일치와 CRLF", () => {
  assert.strictEqual(replacementFor("a\r\nb", regexQuery("a\\nb"), "$0!", false), "a\nb!");
  assert.strictEqual(replacementFor("a\nb", regexQuery("(a)\\n(b)"), "$2\\n$1", false), "b\na");
});

test("replacementFor: lookahead 는 일치한 글만으로는 안 맞아 치환 문자열로 물러나고, 줄 전체(context)를 주면 맞는다", () => {
  const query = regexQuery("(th)is(?=.*bla)");
  assert.strictEqual(replacementFor("this", query, "$1at", false), "$1at");
  assert.strictEqual(replacementInContext("this", "this is a bla text", query, "$1at", false), "that");
});

test("replacementFor: 정규식이 JS 로 해석되지 않으면 던진다", () => {
  assert.throws(() => replacementFor("a", regexQuery("(unclosed"), "x", false), SyntaxError);
  assert.throws(() => replacementFor("a", regexQuery(""), "x", false), /empty string/);
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-sr-")));
let counter = 0;
const workspace = () => {
  const dir = join(root, `ws${counter++}`);
  mkdirSync(dir);
  return dir;
};
const edit = (startLine: number, startCol: number, endLine: number, endCol: number, expected: string, replacement: string): ReplaceEdit => ({ range: { startLine, startCol, endLine, endCol }, expected, replacement });
const one = async (dir: string, path: string, ...edits: ReplaceEdit[]) => (await replaceInWorkspace(dir, [{ path, edits }])).results[0];
const text = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const put = (dir: string, path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test("쓰기: 한 줄 안의 여러 편집이 위치가 밀리지 않고 모두 적용된다", async () => {
  const dir = workspace();
  put(dir, "a.txt", "foo bar foo\nsecond foo line\n");
  const result = await one(dir, "a.txt", edit(0, 0, 0, 3, "foo", "x"), edit(0, 8, 0, 11, "foo", "yyyy"), edit(1, 7, 1, 10, "foo", "z"));
  assert.deepStrictEqual(result, { path: "a.txt", status: "applied", applied: 3 });
  assert.strictEqual(text(dir, "a.txt"), "x bar yyyy\nsecond z line\n");
});

test("쓰기: 편집을 순서 없이 줘도 같은 결과", async () => {
  const dir = workspace();
  put(dir, "a.txt", "abc\n");
  const result = await one(dir, "a.txt", edit(0, 2, 0, 3, "c", "C"), edit(0, 0, 0, 1, "a", "A"));
  assert.strictEqual(result.status, "applied");
  assert.strictEqual(text(dir, "a.txt"), "AbC\n");
});

test("쓰기: 여러 줄 range 와 줄 끝(다음 줄 0열)을 포함하는 range", async () => {
  const dir = workspace();
  put(dir, "m.txt", "one\ntwo\nthree\nfour\n");
  assert.strictEqual((await one(dir, "m.txt", edit(0, 1, 2, 2, "ne\ntwo\nth", "-"))).status, "applied");
  assert.strictEqual(text(dir, "m.txt"), "o-ree\nfour\n");
  put(dir, "n.txt", "one\ntwo\n");
  assert.strictEqual((await one(dir, "n.txt", edit(0, 0, 1, 0, "one\n", ""))).status, "applied");
  assert.strictEqual(text(dir, "n.txt"), "two\n");
});

test("쓰기: UTF-16 열(이모지는 2칸)로 센다", async () => {
  const dir = workspace();
  put(dir, "e.txt", "😀 foo\n");
  assert.strictEqual((await one(dir, "e.txt", edit(0, 3, 0, 6, "foo", "bar"))).status, "applied");
  assert.strictEqual(text(dir, "e.txt"), "😀 bar\n");
  assert.strictEqual((await one(dir, "e.txt", edit(0, 1, 0, 4, "bar", "x"))).status, "conflict");
});

test("conflict: 내용이 바뀐 파일은 하나도 쓰지 않고, 같은 요청의 다른 파일은 쓴다", async () => {
  const dir = workspace();
  put(dir, "good1.txt", "foo\n");
  put(dir, "stale.txt", "foo\nbar\n");
  put(dir, "good2.txt", "foo\n");
  const before = readFileSync(join(dir, "stale.txt"));
  const { results } = await replaceInWorkspace(dir, [
    { path: "good1.txt", edits: [edit(0, 0, 0, 3, "foo", "1")] },
    { path: "stale.txt", edits: [edit(0, 0, 0, 3, "foo", "X"), edit(1, 0, 1, 3, "baz", "Y")] },
    { path: "missing.txt", edits: [edit(0, 0, 0, 1, "a", "b")] },
    { path: "good2.txt", edits: [edit(0, 0, 0, 3, "foo", "2")] },
  ]);
  assert.deepStrictEqual(results.map((r) => [r.path, r.status, r.applied]), [["good1.txt", "applied", 1], ["stale.txt", "conflict", 0], ["missing.txt", "notFound", 0], ["good2.txt", "applied", 1]]);
  assert.ok(readFileSync(join(dir, "stale.txt")).equals(before), "stale.txt 가 그대로");
  assert.strictEqual(text(dir, "good1.txt"), "1\n");
  assert.strictEqual(text(dir, "good2.txt"), "2\n");
});

test("conflict: 파일 뒤쪽이 사라졌거나 줄이 짧아졌으면", async () => {
  const dir = workspace();
  put(dir, "s.txt", "ab\n");
  assert.strictEqual((await one(dir, "s.txt", edit(5, 0, 5, 1, "a", "b"))).status, "conflict");
  assert.strictEqual((await one(dir, "s.txt", edit(0, 1, 0, 9, "b", "c"))).status, "conflict");
  put(dir, "crlf.txt", "ab\r\ncd\r\n");
  assert.strictEqual((await one(dir, "crlf.txt", edit(0, 1, 0, 3, "b\r", "c"))).status, "conflict");
  assert.strictEqual(text(dir, "crlf.txt"), "ab\r\ncd\r\n");
});

test("conflict: 같은 편집을 겹쳐 보낸 두 호출은 하나만 적용된다", async () => {
  const dir = workspace();
  put(dir, "race.txt", "a\n");
  const call = () => one(dir, "race.txt", edit(0, 0, 0, 1, "a", "b"));
  const [first, second] = await Promise.all([call(), call()]);
  assert.deepStrictEqual([first.status, second.status].sort(), ["applied", "conflict"]);
  assert.strictEqual(text(dir, "race.txt"), "b\n");
});

test("겹치는 range 는 error 이고 파일은 그대로", async () => {
  const dir = workspace();
  put(dir, "o.txt", "abcdef\n");
  const overlap = await one(dir, "o.txt", edit(0, 0, 0, 3, "abc", "X"), edit(0, 2, 0, 4, "cd", "Y"));
  assert.strictEqual(overlap.status, "error");
  assert.match(overlap.message ?? "", /overlap/i);
  assert.strictEqual((await one(dir, "o.txt", edit(0, 0, 0, 3, "abc", "X"), edit(0, 0, 0, 3, "abc", "X"))).status, "error");
  assert.strictEqual((await one(dir, "o.txt", edit(0, 1, 0, 1, "", "X"), edit(0, 1, 0, 1, "", "Y"))).status, "error");
  assert.strictEqual((await one(dir, "o.txt", edit(0, 0, 1, 0, "abcdef\n", "X"), edit(0, 3, 0, 4, "d", "Y"))).status, "error");
  assert.strictEqual(text(dir, "o.txt"), "abcdef\n");
  assert.strictEqual((await one(dir, "o.txt", edit(0, 0, 0, 3, "abc", "X"), edit(0, 3, 0, 6, "def", "Y"))).status, "applied");
  assert.strictEqual(text(dir, "o.txt"), "XY\n");
});

test("빈 range(삽입)와 모양이 틀린 요청", async () => {
  const dir = workspace();
  put(dir, "i.txt", "ab\n");
  assert.strictEqual((await one(dir, "i.txt", edit(0, 1, 0, 1, "", "-"))).status, "applied");
  assert.strictEqual(text(dir, "i.txt"), "a-b\n");
  for (const bad of [edit(0, 2, 0, 1, "", "x"), edit(-1, 0, 0, 0, "", "x"), edit(0, 0.5, 0, 1, "", "x"), { range: undefined, expected: "", replacement: "" } as unknown as ReplaceEdit, { range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 }, expected: 1, replacement: "" } as unknown as ReplaceEdit]) {
    assert.strictEqual((await one(dir, "i.txt", bad)).status, "error", JSON.stringify(bad));
  }
  assert.strictEqual((await replaceInWorkspace(dir, [{ path: "i.txt", edits: [] }])).results[0].status, "error");
  assert.strictEqual((await replaceInWorkspace(dir, [{ path: "i.txt" } as unknown as ReplaceFileRequest])).results[0].status, "error");
  assert.strictEqual((await replaceInWorkspace(dir, [{ path: 5 } as unknown as ReplaceFileRequest])).results[0].status, "error");
  assert.strictEqual(text(dir, "i.txt"), "a-b\n");
});

test("같은 파일이 한 요청에 두 번 나오면 두 번째는 error", async () => {
  const dir = workspace();
  put(dir, "d.txt", "a b\n");
  const { results } = await replaceInWorkspace(dir, [
    { path: "d.txt", edits: [edit(0, 0, 0, 1, "a", "1")] },
    { path: "./d.txt", edits: [edit(0, 2, 0, 3, "b", "2")] },
  ]);
  assert.deepStrictEqual(results.map((r) => r.status), ["applied", "error"]);
  assert.strictEqual(text(dir, "d.txt"), "1 b\n");
});

test("작업 폴더 밖: .., 절대 경로, 심볼릭 링크(파일과 폴더)는 outsideWorkspace 이고 밖의 파일은 그대로", async () => {
  const dir = workspace();
  const outsideDir = join(root, `outside${counter++}`);
  mkdirSync(outsideDir);
  const outsideFile = join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "foo\n");
  symlinkSync(outsideFile, join(dir, "link.txt"));
  symlinkSync(outsideDir, join(dir, "linkdir"));
  const attempts = ["../" + outsideDir.split("/").pop() + "/secret.txt", outsideFile, "link.txt", "linkdir/secret.txt", "sub/../../x.txt"];
  for (const path of attempts) {
    const result = await one(dir, path, edit(0, 0, 0, 3, "foo", "bar"));
    assert.strictEqual(result.status, "outsideWorkspace", path);
  }
  assert.strictEqual(readFileSync(outsideFile, "utf8"), "foo\n");
  assert.strictEqual((await one(dir, ".", edit(0, 0, 0, 0, "", "x"))).status, "outsideWorkspace");
});

test("작업 폴더 안의 심볼릭 링크는 링크를 유지하고 가리키는 파일을 고친다", async () => {
  const dir = workspace();
  put(dir, "real.txt", "foo\n");
  symlinkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
  const result = await one(dir, "alias.txt", edit(0, 0, 0, 3, "foo", "bar"));
  assert.strictEqual(result.status, "applied");
  assert.ok(lstatSync(join(dir, "alias.txt")).isSymbolicLink(), "링크가 그대로");
  assert.strictEqual(text(dir, "real.txt"), "bar\n");
  symlinkSync(join(dir, "gone.txt"), join(dir, "dangling.txt"));
  assert.strictEqual((await one(dir, "dangling.txt", edit(0, 0, 0, 1, "a", "b"))).status, "notFound");
});

test("없는 파일, 폴더, .git 안, 읽기 전용, UTF-8 이 아닌 파일", async () => {
  const dir = workspace();
  mkdirSync(join(dir, "sub"));
  put(dir, ".git/config", "foo\n");
  put(dir, "ro.txt", "foo\n");
  chmodSync(join(dir, "ro.txt"), 0o444);
  put(dir, "bin.dat", Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01]));
  put(dir, "bad.txt", Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
  put(dir, "u16.txt", Buffer.from([0xff, 0xfe, 0x66, 0x00, 0x6f, 0x00]));
  const f = edit(0, 0, 0, 1, "f", "g");
  assert.strictEqual((await one(dir, "nope.txt", f)).status, "notFound");
  assert.strictEqual((await one(dir, "nodir/nope.txt", f)).status, "notFound");
  assert.strictEqual((await one(dir, "sub", f)).status, "error");
  assert.strictEqual((await one(dir, ".git/config", edit(0, 0, 0, 3, "foo", "bar"))).status, "error");
  assert.strictEqual(text(dir, ".git/config"), "foo\n");
  if (process.getuid?.() !== 0) assert.strictEqual((await one(dir, "ro.txt", edit(0, 0, 0, 3, "foo", "bar"))).status, "error");
  assert.strictEqual(text(dir, "ro.txt"), "foo\n");
  for (const path of ["bin.dat", "bad.txt", "u16.txt"]) {
    const before = readFileSync(join(dir, path));
    const result = await one(dir, path, f);
    assert.strictEqual(result.status, "error", path);
    assert.ok(readFileSync(join(dir, path)).equals(before), `${path} 그대로`);
  }
});

test("CRLF 는 유지하고, LF 로 온 새 줄바꿈은 파일 표기를 따른다", async () => {
  const dir = workspace();
  put(dir, "c.txt", "a\r\nb\r\nc\r\n");
  assert.strictEqual((await one(dir, "c.txt", edit(1, 0, 1, 1, "b", "x\ny"))).status, "applied");
  assert.strictEqual(text(dir, "c.txt"), "a\r\nx\r\ny\r\nc\r\n");
  assert.strictEqual((await one(dir, "c.txt", edit(0, 0, 1, 1, "a\nx", "Z"))).status, "applied");
  assert.strictEqual(text(dir, "c.txt"), "Z\r\ny\r\nc\r\n");
  assert.strictEqual((await one(dir, "c.txt", edit(0, 0, 1, 1, "Z\r\ny", "Q"))).status, "applied");
  assert.strictEqual(text(dir, "c.txt"), "Q\r\nc\r\n");
  put(dir, "mixed.txt", "a\r\nb\r\nc\nd\r\n");
  assert.strictEqual((await one(dir, "mixed.txt", edit(2, 0, 2, 1, "c", "x\ny"))).status, "applied");
  assert.strictEqual(text(dir, "mixed.txt"), "a\r\nb\r\nx\r\ny\nd\r\n");
  put(dir, "lf.txt", "a\nb\n");
  assert.strictEqual((await one(dir, "lf.txt", edit(0, 0, 0, 1, "a", "x\r\ny"))).status, "applied");
  assert.strictEqual(text(dir, "lf.txt"), "x\ny\nb\n");
});

test("끝 줄바꿈 유무와 BOM 유지", async () => {
  const dir = workspace();
  put(dir, "noeol.txt", "a\nb");
  await one(dir, "noeol.txt", edit(1, 0, 1, 1, "b", "B"));
  assert.strictEqual(text(dir, "noeol.txt"), "a\nB");
  put(dir, "eol.txt", "a\nb\n");
  await one(dir, "eol.txt", edit(1, 0, 1, 1, "b", "B"));
  assert.strictEqual(text(dir, "eol.txt"), "a\nB\n");
  put(dir, "bom.txt", Buffer.concat([BOM, Buffer.from("foo\r\nbar\r\n")]));
  assert.strictEqual((await one(dir, "bom.txt", edit(0, 0, 0, 3, "foo", "한글"))).status, "applied");
  const bytes = readFileSync(join(dir, "bom.txt"));
  assert.ok(bytes.subarray(0, 3).equals(BOM) && !bytes.subarray(3, 6).equals(BOM), "BOM 한 개");
  assert.strictEqual(bytes.subarray(3).toString("utf8"), "한글\r\nbar\r\n");
  put(dir, "nobom.txt", "foo\n");
  await one(dir, "nobom.txt", edit(0, 0, 0, 3, "foo", "bar"));
  assert.ok(!readFileSync(join(dir, "nobom.txt")).subarray(0, 3).equals(BOM));
});

test("권한 유지, 임시 파일 흔적 없음, 바뀌지 않으면 쓰지 않음", async () => {
  const dir = workspace();
  put(dir, "run.sh", "foo\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  put(dir, "priv.txt", "foo\n");
  chmodSync(join(dir, "priv.txt"), 0o600);
  await one(dir, "run.sh", edit(0, 0, 0, 3, "foo", "bar"));
  await one(dir, "priv.txt", edit(0, 0, 0, 3, "foo", "bar"));
  assert.strictEqual(statSync(join(dir, "run.sh")).mode & 0o7777, 0o755);
  assert.strictEqual(statSync(join(dir, "priv.txt")).mode & 0o7777, 0o600);
  assert.deepStrictEqual(readdirSync(dir).sort(), ["priv.txt", "run.sh"]);
  const before = statSync(join(dir, "run.sh"));
  await new Promise((r) => setTimeout(r, 20));
  const noop = await one(dir, "run.sh", edit(0, 0, 0, 3, "bar", "bar"));
  assert.deepStrictEqual(noop, { path: "run.sh", status: "applied", applied: 1 });
  assert.strictEqual(statSync(join(dir, "run.sh")).mtimeMs, before.mtimeMs);
  assert.strictEqual(statSync(join(dir, "run.sh")).ino, before.ino);
});

test("상한: 파일 수와 파일당 편집 수를 넘으면 요청 전체를 거절하고 아무것도 쓰지 않는다", async () => {
  const dir = workspace();
  put(dir, "lim.txt", "a\n");
  const tooMany = Array.from({ length: REPLACE_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, edits: [edit(0, 0, 0, 1, "a", "b")] }));
  await assert.rejects(replaceInWorkspace(dir, tooMany), /Too many files/);
  const manyEdits = Array.from({ length: REPLACE_MAX_EDITS_PER_FILE + 1 }, () => edit(0, 0, 0, 1, "a", "b"));
  await assert.rejects(replaceInWorkspace(dir, [{ path: "lim.txt", edits: manyEdits }, { path: "lim.txt", edits: [] }]), /Too many edits/);
  await assert.rejects(replaceInWorkspace(dir, "x" as unknown as ReplaceFileRequest[]), /array/);
  assert.strictEqual(text(dir, "lim.txt"), "a\n");
});

test("상한 경계: 파일당 편집 수가 딱 상한이면 처리한다", async () => {
  const dir = workspace();
  put(dir, "edge.txt", "a".repeat(REPLACE_MAX_EDITS_PER_FILE) + "\n");
  const edits = Array.from({ length: REPLACE_MAX_EDITS_PER_FILE }, (_, i) => edit(0, i, 0, i + 1, "a", "b"));
  const result = await one(dir, "edge.txt", ...edits);
  assert.deepStrictEqual(result, { path: "edge.txt", status: "applied", applied: REPLACE_MAX_EDITS_PER_FILE });
  assert.strictEqual(text(dir, "edge.txt"), "b".repeat(REPLACE_MAX_EDITS_PER_FILE) + "\n");
});

test("장부: 에이전트가 쓴 파일을 바꾸면 사람이 고친 것으로 보이고, 에이전트가 안 만진 파일은 세션 변경에 들지 않는다", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-nav-sr-home-"));
  const savedHome = process.env.AGENT_NAV_HOME;
  process.env.AGENT_NAV_HOME = home;
  try {
    const touch = await import("../server/sessionTouch");
    const { HOME } = await import("../server/store");
    assert.strictEqual(HOME, home, "장부 홈이 임시 폴더");
    const repo = workspace();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    put(repo, "a.ts", "a1\n");
    put(repo, "b.ts", "b1\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const store = { changes: () => [], change: () => undefined, timeline: () => [] } as never;
    const agent = { id: "sr-agent", cwd: repo, worktree: null, startCommit: git("rev-parse", "HEAD"), feedbackId: null, workspaceId: "w1", forkBased: undefined } as unknown as Parameters<typeof touch.ensureLedger>[0];

    const input = { file_path: join(repo, "a.ts") };
    await touch.recordBeforeEdit(agent, store, "Write", input);
    writeFileSync(join(repo, "a.ts"), "a1\nfoo\n");
    await touch.recordAfterEdit(agent, store, "Write", input);
    const names = async () => (await touch.touchedChanges(agent, store)).files.map((f) => `${f.rel}${f.modifiedSince ? "*" : ""}`).join(" ");
    assert.strictEqual(await names(), "a.ts");

    const { results } = await replaceInWorkspace(repo, [
      { path: "a.ts", edits: [edit(1, 0, 1, 3, "foo", "bar")] },
      { path: "b.ts", edits: [edit(0, 0, 0, 2, "b1", "b2")] },
    ]);
    assert.deepStrictEqual(results.map((r) => r.status), ["applied", "applied"]);
    assert.strictEqual(await names(), "a.ts*", "a.ts 에 표시가 붙고 b.ts 는 목록에 들지 않는다");
    const undo = await touch.checkUndo(agent, store, [join(repo, "a.ts")]);
    assert.ok(undo.allowed.length === 0 && undo.skipped[0]?.reason === "modified", `Undo 거부: ${JSON.stringify(undo)}`);
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_NAV_HOME;
    else process.env.AGENT_NAV_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("모바일 허용 목록과 에이전트 도구에 없다", () => {
  assert.ok(!(MOBILE_METHODS as readonly string[]).includes("search.replace"));
  const files = readdirSync("server").filter((name) => name.endsWith(".ts"));
  const mentioning = files.filter((name) => readFileSync(join("server", name), "utf8").includes('"search.replace"'));
  assert.deepStrictEqual(mentioning, ["fileHandlers.ts"], "RPC 핸들러 등록 한 곳뿐");
  const toolFiles = files.filter((name) => /Tools?\.ts$|^mcp|Host\.ts$/.test(name));
  for (const name of toolFiles) assert.ok(!/searchReplace|replaceInWorkspace/.test(readFileSync(join("server", name), "utf8")), `${name} 이 쓰지 않는다`);
});

type Reply = { result?: unknown; error?: string; events: ServerMessage[] };

async function call(daemon: Awaited<ReturnType<typeof useTestDaemon>>, method: string, params: unknown): Promise<Reply> {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
  await new Promise((resolve) => socket.on("open", resolve));
  socket.send(JSON.stringify({ id: 7, method, params }));
  const events: ServerMessage[] = [];
  const reply = await new Promise<{ result?: unknown; error?: string }>((resolve) =>
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as ServerMessage & { id?: number };
      if (message.id === 7) resolve(message as { result?: unknown; error?: string });
      else events.push(message);
    }),
  );
  socket.close();
  return { ...reply, events };
}

test("RPC 왕복: search.replace 가 파일을 고치고 workspaceChanged 를 알리며, 밖의 경로와 상한을 거절한다", async () => {
  const daemon = await useTestDaemon();
  try {
    const workspaces = (await call(daemon, "workspaces.list", {})).result as { id: string; dir: string }[];
    const { id, dir } = workspaces[0];
    const name = `sr-roundtrip-${process.pid}.txt`;
    put(dir, name, "hello world\nsecond\n");
    try {
      const ok = await call(daemon, "search.replace", { workspaceId: id, files: [{ path: name, edits: [edit(0, 6, 0, 11, "world", "there")] }] });
      assert.deepStrictEqual(ok.result, { results: [{ path: name, status: "applied", applied: 1 }] });
      assert.strictEqual(text(dir, name), "hello there\nsecond\n");
      assert.ok(ok.events.some((e) => "event" in e && e.event.type === "workspaceChanged" && e.event.workspaceIds.includes(id)), "workspaceChanged 이벤트");

      const stale = await call(daemon, "search.replace", { workspaceId: id, files: [{ path: name, edits: [edit(0, 6, 0, 11, "world", "again")] }] });
      assert.strictEqual((stale.result as { results: { status: string }[] }).results[0].status, "conflict");
      assert.strictEqual(text(dir, name), "hello there\nsecond\n");
      assert.ok(!stale.events.some((e) => "event" in e && e.event.type === "workspaceChanged"), "쓰지 않았으면 알리지 않는다");

      const hosts = readFileSync("/etc/hosts", "utf8");
      const outside = await call(daemon, "search.replace", { workspaceId: id, files: ["../../../../etc/hosts", "/etc/hosts"].map((path) => ({ path, edits: [edit(0, 0, 0, 1, hosts[0], "X")] })) });
      assert.deepStrictEqual((outside.result as { results: { status: string }[] }).results.map((r) => r.status), ["outsideWorkspace", "outsideWorkspace"]);
      assert.strictEqual(readFileSync("/etc/hosts", "utf8"), hosts);

      const unknown = await call(daemon, "search.replace", { workspaceId: "no-such-workspace", files: [] });
      assert.ok(typeof unknown.error === "string", "알 수 없는 워크스페이스");
      const tooMany = await call(daemon, "search.replace", { workspaceId: id, files: Array.from({ length: REPLACE_MAX_FILES + 1 }, (_, i) => ({ path: `x${i}`, edits: [] })) });
      assert.match(tooMany.error ?? "", /Too many files/);
    } finally {
      rmSync(join(dir, name), { force: true });
    }
  } finally {
    daemon.stop();
  }
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
