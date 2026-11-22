export function isGeneratedPath(path: string): boolean {
  return /(^|\/)__generated__\//.test(path) || path.endsWith(".graphql.ts");
}
