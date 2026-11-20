// 없는 파일을 가리키는 대화 링크와, 그 링크를 눌렀을 때 에디터에 뜨는 빈 화면의 문구. 영어 UI 문구만 둔다.
export const MF = {
  linkTip: "This file doesn't exist yet",
  title: "doesn't exist",
  create: "Create File",
  createWithCode: "Create File with This Code",
  createFailed: (message: string) => `Could not create the file. ${message}`,
};
