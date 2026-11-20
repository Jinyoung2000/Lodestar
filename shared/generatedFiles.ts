// diff 화면(Changes 패널, PR Files Changed)에서 감추는 생성 파일. Relay 컴파일러 산출물(__generated__ 폴더, *.graphql.ts)처럼 사람이 읽고 리뷰하지 않는 파일이다.
// 목록에서만 빼고 Keep All, Undo All 같은 일괄 동작은 전체 파일에 그대로 건다(소스만 되돌리고 생성 파일이 남지 않게).
export function isGeneratedPath(path: string): boolean {
  return /(^|\/)__generated__\//.test(path) || path.endsWith(".graphql.ts");
}
