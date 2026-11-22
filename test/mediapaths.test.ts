import assert from "node:assert/strict";
import { hideLocalImages } from "../web/mediaHtml";
import { parseMarkdown } from "../web/markdownParse";
import { findMediaPaths, isPlausibleMediaPath, localImageTarget, mayContainMedia, mediaKindOf } from "../shared/media";

const SHOT = "/private/tmp/claude-502/-Users-me--agent-nav-chats-d4c9cdcc/scratchpad/chat-menu-halfview-after.png";

assert.equal(mayContainMedia("그냥 글"), false);
assert.equal(mayContainMedia("a.png"), true);
assert.equal(mayContainMedia("a.pngx"), false);
assert.deepEqual(findMediaPaths("미디어 경로 없음"), []);

assert.equal(mediaKindOf("/a/b.PNG"), "image");
assert.equal(mediaKindOf("/a/b.mov"), "video");
assert.equal(mediaKindOf("/a/b.ts"), null);
assert.equal(mediaKindOf("/a/png"), null);

assert.deepEqual(findMediaPaths(`- 스크린샷: ${SHOT}\n- 끝`), [SHOT]);
assert.deepEqual(findMediaPaths(`스크린샷은 ${SHOT}.`), [SHOT]);
assert.deepEqual(findMediaPaths(`(${SHOT})`), [SHOT]);
assert.deepEqual(findMediaPaths(`**${SHOT}** 입니다`), [SHOT]);
assert.deepEqual(findMediaPaths(`스크린샷:${SHOT}\n`), [SHOT]);
assert.deepEqual(findMediaPaths("영상 /tmp/한글 폴더/녹화.mp4"), [], "공백이 낀 맨 경로는 잇지 않는다");
assert.deepEqual(findMediaPaths("영상 /tmp/녹화-한글.mov 확인"), ["/tmp/녹화-한글.mov"]);

assert.deepEqual(findMediaPaths(`\`${SHOT}\``), [SHOT]);
assert.deepEqual(findMediaPaths("`/tmp/한글 폴더/녹화 1.mp4`"), ["/tmp/한글 폴더/녹화 1.mp4"]);
assert.deepEqual(findMediaPaths("`/tmp/a/very-long-dir/\nshot.png`"), ["/tmp/a/very-long-dir/shot.png"]);
assert.deepEqual(findMediaPaths("`open /tmp/x.png`"), ["/tmp/x.png"]);
assert.deepEqual(findMediaPaths("`~/Desktop/a.webp`"), ["~/Desktop/a.webp"]);

assert.deepEqual(findMediaPaths("스크린샷은 /private/tmp/claude-502/-Users-me--agent-nav/scratchpad/chat-menu-\nhalfview-after.png 입니다"), [
  "/private/tmp/claude-502/-Users-me--agent-nav/scratchpad/chat-menu-halfview-after.png",
]);
assert.deepEqual(findMediaPaths("저장 위치 /tmp/abc/\n  result.png"), ["/tmp/abc/result.png"]);
assert.deepEqual(findMediaPaths("Saved to /tmp/a.png\nb.png shows the before state"), ["/tmp/a.png"], "이미 확장자로 끝난 경로 뒤 줄은 잇지 않는다");
assert.deepEqual(findMediaPaths("결과:\n/tmp/a.png\n/tmp/b.png\n"), ["/tmp/a.png", "/tmp/b.png"], "서로 다른 줄의 두 경로는 잇지 않는다");

assert.deepEqual(findMediaPaths(`![alt](${SHOT})`), [SHOT]);
assert.deepEqual(findMediaPaths("![](screens/a.png)"), ["screens/a.png"]);
assert.deepEqual(findMediaPaths('![](./screens/a.png "x")'), ["./screens/a.png"]);
assert.deepEqual(findMediaPaths("![x](<~/Pictures/my shot.png>)"), ["~/Pictures/my shot.png"]);
assert.deepEqual(findMediaPaths("![](file:///tmp/a%20b.png)"), ["/tmp/a b.png"]);
assert.deepEqual(findMediaPaths("![](https://example.com/a.png)"), []);
assert.deepEqual(findMediaPaths("![](data:image/png;base64,AAAA)"), []);
assert.deepEqual(findMediaPaths("![](//cdn.example.com/a.png)"), []);
assert.deepEqual(findMediaPaths("[링크](https://example.com/x/y.png)"), []);

assert.deepEqual(findMediaPaths("public/logo.png 를 바꿨다"), []);
assert.deepEqual(findMediaPaths("`public/logo.png` 를 바꿨다"), []);
assert.deepEqual(findMediaPaths("./screens/a.png"), []);
assert.deepEqual(findMediaPaths("../a.png"), []);

assert.deepEqual(findMediaPaths(`\`\`\`\n${SHOT}\n\`\`\``), [SHOT]);
assert.deepEqual(findMediaPaths("```sh\nopen /tmp/x.png\n```"), []);
assert.deepEqual(findMediaPaths("```js\nawait page.screenshot({ path: '/tmp/x.png' })\n```"), []);
assert.deepEqual(findMediaPaths("```\n/tmp/x.png\n```\n본문 /tmp/y.png"), ["/tmp/x.png", "/tmp/y.png"]);
assert.deepEqual(findMediaPaths("~~~\n/tmp/x.mp4\n~~~"), ["/tmp/x.mp4"]);

assert.deepEqual(findMediaPaths("/tmp/a.png 그리고 `/tmp/b.png` 그리고 ![](/tmp/c.png)"), ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
assert.deepEqual(findMediaPaths("![](/tmp/c.png) 그리고 `/tmp/b.png` 그리고 /tmp/a.png"), ["/tmp/c.png", "/tmp/b.png", "/tmp/a.png"]);
assert.deepEqual(findMediaPaths("/tmp/x.png\n```\n/tmp/y.png\n```\n`/tmp/z.mp4`"), ["/tmp/x.png", "/tmp/y.png", "/tmp/z.mp4"]);

assert.deepEqual(findMediaPaths("/tmp/a.png 와 /tmp/b.png 와 /tmp/a.png"), ["/tmp/a.png", "/tmp/b.png"]);
assert.deepEqual(findMediaPaths("/tmp/../etc/a.png"), []);
assert.deepEqual(findMediaPaths("https://example.com/a.png"), []);
assert.deepEqual(findMediaPaths("/tmp/a.png.bak"), []);
assert.deepEqual(findMediaPaths("/tmp/a.pngx"), []);
assert.deepEqual(findMediaPaths("/tmp/a.txt"), []);
assert.deepEqual(findMediaPaths("src/tmp/a.png"), [], "앞 조각이 붙은 상대 경로의 뒷부분만 절대 경로로 읽지 않는다");

assert.deepEqual(findMediaPaths(SHOT, { streaming: true }), [], "글 끝에서 끝나는 맨 경로");
assert.deepEqual(findMediaPaths(`${SHOT}\n`, { streaming: true }), [SHOT], "줄이 끝난 맨 경로");
assert.deepEqual(findMediaPaths(`${SHOT} 입니다`, { streaming: true }), [SHOT]);
assert.deepEqual(findMediaPaths(`\`${SHOT}`, { streaming: true }), [], "닫히지 않은 코드");
assert.deepEqual(findMediaPaths(`\`${SHOT}\``, { streaming: true }), [SHOT], "닫힌 코드");
assert.deepEqual(findMediaPaths(`![](${SHOT}`, { streaming: true }), [], "닫히지 않은 이미지 문법");
assert.deepEqual(findMediaPaths(`![](${SHOT})`, { streaming: true }), [SHOT]);
assert.deepEqual(findMediaPaths(`\`\`\`\n${SHOT}`, { streaming: true }), [], "줄바꿈이 오지 않은 코드 블록 속 경로");
assert.deepEqual(findMediaPaths(`\`\`\`\n${SHOT}\n`, { streaming: true }), [SHOT]);
assert.deepEqual(findMediaPaths("/tmp/abc/shot.p", { streaming: true }), [], "확장자를 쓰다 만 경로");
assert.deepEqual(findMediaPaths("/tmp/abc/sh", { streaming: true }), []);
assert.deepEqual(findMediaPaths("/tmp/abc/shot.png", { streaming: false }), ["/tmp/abc/shot.png"], "끝난 글에서는 글 끝의 경로도 받는다");

assert.equal(isPlausibleMediaPath("/a/b.png"), true);
assert.equal(isPlausibleMediaPath("a/b.png"), true);
assert.equal(isPlausibleMediaPath("/a/b.png\0"), false);
assert.equal(isPlausibleMediaPath("/a/../b.png"), false);
assert.equal(isPlausibleMediaPath(`/${"a".repeat(1100)}.png`), false);
assert.equal(isPlausibleMediaPath("//host/a.png"), false);
assert.equal(localImageTarget("a.png?x=1#y"), "a.png");
assert.equal(localImageTarget("http://x/a.png"), null);

assert.equal(hideLocalImages("<p>글</p>"), "<p>글</p>");
assert.equal(hideLocalImages('<p><img src="/tmp/a/b.png" alt="결과"></p>'), '<p><span class="media-local-image" title="/tmp/a/b.png">결과</span></p>');
assert.equal(hideLocalImages('<img src="shots/c.png" alt="">'), '<span class="media-local-image" title="shots/c.png">c.png</span>');
assert.equal(hideLocalImages('<img src="https://example.com/a.png" alt="x">'), '<img src="https://example.com/a.png" alt="x">');
assert.equal(hideLocalImages('<img src="data:image/png;base64,AAAA" alt="x">'), '<img src="data:image/png;base64,AAAA" alt="x">');
assert.equal(hideLocalImages('<img src="/tmp/doc.bmp" alt="x">'), '<img src="/tmp/doc.bmp" alt="x">', "미디어 확장자가 아니면 그대로");
assert.match(hideLocalImages(parseMarkdown("![스샷](/private/tmp/claude-502/s/a.png)")), /<span class="media-local-image" title="\/private\/tmp\/claude-502\/s\/a\.png">스샷<\/span>/);
assert.match(hideLocalImages(parseMarkdown("![](screens/a%20b.png)")), /media-local-image/);

console.log("mediapaths ok");
