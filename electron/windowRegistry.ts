import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseRegistry, serializeRegistry, type Registry } from "../shared/windows";

// 창 목록(shared/windows.ts Registry)을 파일에 읽고 쓴다. 파일은 localStorage 와 같은 데이터 폴더(userData)에 둔다:
// 창 id 가 가리키는 저장본(localStorage)과 이 목록이 같이 다녀야 하므로, 시험 인스턴스가 AGENT_NAV_USER_DATA 를 바꾸면 둘 다 따로 간다.
export function loadRegistry(file: string): Registry {
  try {
    return parseRegistry(readFileSync(file, "utf8"));
  } catch {
    return parseRegistry(null);
  }
}

export function saveRegistry(file: string, registry: Registry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeRegistry(registry));
  } catch (error) {
    console.error("[windows] could not save the window list", error);
  }
}
