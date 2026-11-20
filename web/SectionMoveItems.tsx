import { moveSidebarSection, useSidebarOrder, type SidebarSection } from "./sidebarOrder";
import { S } from "./strings";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";

// 사이드바 구역 머리의 더보기 메뉴 끝에 붙는 Move Up, Move Down. 맨 위 구역은 위로, 맨 아래 구역은 아래로 옮길 수 없다.
export function SectionMoveItems({ id }: { id: SidebarSection }) {
  const order = useSidebarOrder();
  const index = order.indexOf(id);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={index <= 0} onSelect={() => moveSidebarSection(id, -1)}>
        <span className="session-menu-check" />
        {S.moveSectionUp}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={index < 0 || index >= order.length - 1} onSelect={() => moveSidebarSection(id, 1)}>
        <span className="session-menu-check" />
        {S.moveSectionDown}
      </DropdownMenuItem>
    </>
  );
}
