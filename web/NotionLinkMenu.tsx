import { useEffect, useState } from "react";
import { isNotionUrl } from "../shared/notionLink";
import { hint } from "./hint";
import { openNotionScreen } from "./notionScreen";
import { N } from "./notionStrings";
import { guessTitle, openNotionInApp, pinFor, pinNotionPage, unpinNotionPage, useNotion } from "./notionStore";
import { flash } from "./store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

type Anchor = { x: number; y: number; url: string; text: string };

export function NotionLinkMenu() {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const pins = useNotion((s) => s.pins);

  useEffect(() => {
    const onContext = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !isNotionUrl(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, url: anchor.href, text: (anchor.textContent ?? "").trim() });
    };
    document.addEventListener("contextmenu", onContext, true);
    return () => document.removeEventListener("contextmenu", onContext, true);
  }, []);

  const pin = menu ? pinFor(pins, menu.url) : null;
  const copy = (url: string) => void navigator.clipboard.writeText(url).then(() => hint(N.copied, undefined, { check: true }), () => flash(N.copyLink));

  return (
    <DropdownMenu open={!!menu} onOpenChange={(open) => !open && setMenu(null)} modal={false}>
      <DropdownMenuTrigger asChild>
        <span className="context-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={0} className="session-menu" data-menu="notion-link">
        <DropdownMenuItem onSelect={() => menu && openNotionScreen(menu.url)}>
          <span>{N.openInView}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => menu && openNotionInApp(menu.url)}>
          <span>{N.openInTab}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            if (!menu) return;
            if (pin) void unpinNotionPage(pin.id);
            else void pinNotionPage({ title: menu.text && !isNotionUrl(menu.text) && !/^https?:/i.test(menu.text) ? menu.text : guessTitle(menu.url), url: menu.url });
          }}
        >
          <span>{pin ? N.unpinFromSidebar : N.pinToSidebar}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => menu && copy(menu.url)}>
          <span>{N.copyLink}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
