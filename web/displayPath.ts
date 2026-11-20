// 화면에 보이는 경로: 홈은 ~, macOS 의 /private/tmp 와 /private/var 는 사용자가 아는 /tmp 와 /var 로. 비교와 저장에는 쓰지 않는다(내부는 realpath 그대로).
export function displayPath(path: string) {
  return path.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}
