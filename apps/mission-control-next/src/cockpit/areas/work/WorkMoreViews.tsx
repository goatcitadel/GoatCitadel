import { MoreHorizontal } from "lucide-react";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../../ui/Menu";

/** The older Kanban stays reachable at /work/kanban, but no longer sits in the main Work tab row (WK-01). */
export const OLDER_KANBAN_VIEW = { id: "kanban", label: "Older Kanban view", href: "/work/kanban" } as const;

/** WK-01: the Work header's overflow menu for views that are kept but are not part of the main tab row. */
export function WorkMoreViews() {
  const { navigate } = useCockpitRoute();
  return (
    <Menu>
      <MenuTrigger
        aria-label="More Work views"
        className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-sm text-fg-secondary hover:border-accent max-sm:min-h-11"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" /> More
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem className="max-sm:min-h-11" onSelect={() => navigate(OLDER_KANBAN_VIEW.href)}>
          {OLDER_KANBAN_VIEW.label}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
