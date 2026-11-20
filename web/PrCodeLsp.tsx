import { useEffect, useRef, useState } from "react";
import { findRow, type DiffRow } from "../shared/prDiff";
import type { PrFile } from "../shared/prTypes";
import { Codicon } from "./icons";
import { PrCodeLsp } from "./prLspController";
import { usePrView } from "./prStore";
import { P } from "./prStrings";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { takePendingReveal, type PrLsp, type PrLspStatus, type PrReferences } from "./usePrLsp";

// PR diff 의 코드 칸에 언어 기능을 잇는 React 쪽: 컨트롤러 만들고 치우기, 정의 이동으로 도착한 줄 보이기, 오른쪽 클릭 메뉴, 참조 목록, 파일 머리의 상태 표시.

const FLASH_MS = 1400;

export function usePrCodeLsp(file: PrFile, rows: DiffRow[], lsp: PrLsp) {
  const rootRef = useRef<HTMLDivElement>(null);
  const controller = useRef<PrCodeLsp | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const latest = useRef(lsp);
  latest.current = lsp;
  const ref = usePrView((v) => v.ref);
  const refKey = ref ? `${ref.repo}#${ref.number}` : "";
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 컨트롤러가 아직 없을 때(문서를 여는 중) 도착한 줄은 컨트롤러가 생기면 캐럿을 둔다
  const wantedCaret = useRef<{ index: number; character: number } | null>(null);

  // 줄(1부터)로 가서 가운데에 보이고 잠깐 강조한다
  const reveal = (line: number, character: number) => {
    const index = findRow(rowsRef.current, "RIGHT", line);
    const cell = rootRef.current?.querySelector<HTMLElement>(`code.pr-code[data-row="${index}"][data-side="RIGHT"]`);
    if (index === -1 || !cell) return;
    cell.scrollIntoView({ block: "center", behavior: "instant" });
    cell.dataset.flash = "";
    setTimeout(() => delete cell.dataset.flash, FLASH_MS);
    wantedCaret.current = { index, character };
    controller.current?.caretAt(index, character);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !lsp.doc) return;
    const instance = new PrCodeLsp(root, {
      rows: () => rowsRef.current,
      doc: () => latest.current.doc,
      definition: (doc, pos) => latest.current.definition(doc, pos),
      references: (doc, pos, word) => latest.current.references(doc, pos, word),
      navigate: (location, from) => latest.current.navigate(location, from),
      mismatch: () => latest.current.reportMismatch(),
      contextMenu: (x, y) => setMenu({ x, y }),
    });
    controller.current = instance;
    const wanted = wantedCaret.current;
    if (wanted) instance.caretAt(wanted.index, wanted.character);
    latest.current.revealHere.current = reveal;
    return () => {
      instance.destroy();
      controller.current = null;
      if (latest.current.revealHere.current === reveal) latest.current.revealHere.current = null;
    };
    // reveal 은 ref 만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsp.doc]);

  // 다른 파일에서 정의 이동으로 넘어온 경우: 이 파일이 열린 직후 그 줄로 간다
  useEffect(() => {
    wantedCaret.current = null;
    const pending = takePendingReveal(refKey, file.path);
    if (pending) reveal(pending.line, pending.character);
    // reveal 은 ref 만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, rows]);

  return {
    rootRef,
    menu,
    closeMenu: () => setMenu(null),
    goToDefinition: () => void controller.current?.goToDefinition(),
    findReferences: () => void controller.current?.findReferences(),
  };
}

export function CodeMenu({ menu, onClose, onDefinition, onReferences }: { menu: { x: number; y: number }; onClose: () => void; onDefinition: () => void; onReferences: () => void }) {
  return (
    <DropdownMenu open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="pr-lsp-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={onDefinition}>
          {S.goToDefinition}
          <span className="faint xs menu-hint">F12</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onReferences}>
          {S.goToReferences}
          <span className="faint xs menu-hint">⇧F12</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 파일 머리의 상태 표시. 언어 기능이 켜졌는지, 어느 글을 쓰는지, 꺼졌다면 이유를 title 로 알린다.
export function PrLspChip({ status, mismatched, repo }: { status: PrLspStatus; mismatched: boolean; repo: string }) {
  if (status.kind === "none") return null;
  const text = chipText(status, mismatched, repo);
  return (
    <span className="pr-lsp-chip" data-state={status.kind === "ready" && !mismatched ? "on" : status.kind === "loading" ? "loading" : "off"} title={text.title} data-testid="pr-lsp-chip">
      <Codicon name={status.kind === "ready" && !mismatched ? "symbol-method" : "circle-slash"} size={12} />
      {text.label}
    </span>
  );
}

function chipText(status: PrLspStatus, mismatched: boolean, repo: string): { label: string; title: string } {
  if (status.kind === "loading") return { label: P.lspLoading, title: P.lspLoadingTitle };
  if (status.kind === "off") return { label: P.lspOff, title: P.lspOffReason(status.reason, repo, status.dir) };
  if (status.kind !== "ready") return { label: "", title: "" };
  if (mismatched) return { label: P.lspDiffers, title: P.lspDiffersTitle(status.dir) };
  if (status.mode === "checked-out") return { label: P.lspLocal, title: P.lspLocalTitle(status.dir, status.exact) };
  return { label: P.lspCommit(status.sha.slice(0, 7)), title: P.lspCommitTitle(status.sha.slice(0, 7), status.dir) };
}

// 참조 목록. 오른쪽 패널이 닫혀 있는 PR 화면에서도 보이도록 파일 diff 아래에 놓는다. 항목을 누르면 PR diff 안 줄이나 에디터 탭으로 간다.
export function PrReferencesPanel({ refs, onOpen, onClose }: { refs: PrReferences; onOpen: (hit: PrReferences["groups"][number]["hits"][number]) => void; onClose: () => void }) {
  return (
    <div className="pr-refs" role="region" aria-label={refs.title} data-testid="pr-refs">
      <div className="pr-refs-head">
        <span className="pr-refs-title">{refs.title}</span>
        <span className="spacer" />
        <button type="button" className="pr-refs-close" aria-label={P.closeReferences} title={P.closeReferences} onClick={onClose}>
          <Codicon name="close" size={14} />
        </button>
      </div>
      <div className="pr-refs-list">
        {refs.groups.length === 0 && <div className="pr-faint pr-refs-empty">{P.noReferences}</div>}
        {refs.groups.map((group) => (
          <div key={group.path} className="pr-refs-group">
            <div className="pr-refs-path">{group.path}</div>
            {group.hits.map((hit, i) => (
              <button key={i} type="button" className="pr-refs-hit" onClick={() => onOpen(hit)}>
                <span className="pr-refs-line">{hit.line}</span>
                <span className="pr-refs-text">{hit.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
