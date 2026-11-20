import { allUploaded, resizeTarget, uploadProgress, type Attachment } from "../src/logic/images";
import { expect, run, test } from "./harness";

test("resizeTarget: 긴 변이 2048 을 넘을 때만 비율을 지켜 줄인다", () => {
  expect(JSON.stringify(resizeTarget(4032, 3024)) === '{"width":2048,"height":1536}', "12MP landscape");
  expect(JSON.stringify(resizeTarget(3024, 4032)) === '{"width":1536,"height":2048}', "12MP portrait");
  expect(resizeTarget(2048, 1000) === null && resizeTarget(800, 600) === null, "already small");
  expect(JSON.stringify(resizeTarget(10000, 1)) === '{"width":2048,"height":1}', "never below 1px");
  expect(resizeTarget(0, 0) === null, "bad size");
  return "ok";
});

const att = (status: Attachment["status"], progress = 0): Attachment => ({ key: String(Math.random()), name: "a", uri: "u", status, progress });

test("uploadProgress: 진행 중이 없으면 null, 있으면 전체 평균", () => {
  expect(uploadProgress([att("done"), att("done")]) === null, "all done");
  expect(uploadProgress([att("done"), att("uploading", 0.5)]) === 0.75, "half of second");
  expect(uploadProgress([att("processing"), att("error")]) === 0, "errors do not count");
  expect(allUploaded([att("done")]) && !allUploaded([att("done"), att("error")]), "allUploaded");
  return "ok";
});

void run();
