import { moveSidebarSection, useSidebarOrder, type SidebarSection } from "./sidebarOrder";
import { S } from "./strings";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";

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
