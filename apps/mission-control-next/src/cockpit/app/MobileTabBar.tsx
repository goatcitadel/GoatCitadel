import { useRef, useState } from "react";
import { Activity, Inbox, LayoutGrid, Library, MessageSquare, MoreHorizontal, Search, Settings } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import {
  inboxCountLabel,
  inboxCountTitle,
  inboxMatchesWorkspace,
  inboxNavigationLabel,
} from "../areas/inbox/inbox-presentation";
import { useOperatorInbox } from "../data/use-operator-inbox";
import { useCockpitNavigation } from "./cockpit-navigation-context";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { Sheet } from "../ui/Sheet";
import { useCockpitRoute } from "./use-cockpit-route";
import { useCockpitPreload } from "./use-cockpit-preload";

const TABS = [
  { area: "chat", label: "Chat", path: "/chat", Icon: MessageSquare },
  { area: "inbox", label: "Inbox", path: "/inbox", Icon: Inbox },
  { area: "work", label: "Work", path: "/work", Icon: LayoutGrid },
  { area: "library", label: "Library", path: "/library", Icon: Library },
] as const;

export function MobileTabBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { isTransitionPending } = useCockpitNavigation();
  const shellSwitch = useCockpitShellSwitch();
  const { area: current, navigate } = useCockpitRoute();
  const preload = useCockpitPreload();
  const { activeWorkspaceId, theme, setTheme } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const inbox = useOperatorInbox(workspaceId);
  const inboxCount = inboxCountLabel(
    !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined,
  );
  const moreButton = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const openArea = (path: string) => {
    setMoreOpen(false);
    navigate(path);
  };
  return (
    <>
      <nav
        aria-label="Areas on small screens"
        className="flex shrink-0 border-t border-line-subtle bg-raised sm:hidden"
      >
        {TABS.map(({ area, label, path, Icon }) => (
          <button
            key={area}
            type="button"
            aria-current={current === area ? "page" : undefined}
            aria-label={area === "inbox" && inboxCount ? inboxNavigationLabel(inboxCount) : undefined}
            onClick={() => navigate(path)}
            onPointerEnter={() => preload(area)}
            onFocus={() => preload(area)}
            onPointerDown={() => preload(area)}
            className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs text-fg-muted aria-[current=page]:text-fg"
          >
            <span className="relative">
              <Icon aria-hidden="true" className="size-5" />
              {area === "inbox" && inboxCount ? (
                <span
                  title={inboxCountTitle(inboxCount)}
                  className="absolute -right-3 -top-1 min-w-4 rounded-full bg-accent px-0.5 text-center text-xs font-semibold text-accent-ink"
                >
                  {inboxCount}
                </span>
              ) : null}
            </span>
            {label}
          </button>
        ))}
        <button
          ref={moreButton}
          type="button"
          aria-label="More areas and settings"
          aria-expanded={moreOpen}
          onClick={() => {
            if (!isTransitionPending()) setMoreOpen(true);
          }}
          className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs text-fg-muted"
        >
          <MoreHorizontal aria-hidden="true" className="size-5" />
          More
        </button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="More">
        <div className="grid gap-1">
          <button
            type="button"
            onClick={() => {
              if (isTransitionPending()) return;
              setMoreOpen(false);
              setScopeOpen(true);
            }}
            className="flex min-h-11 items-center rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            Change Citadel and workspace
          </button>
          <button
            type="button"
            onPointerEnter={() => preload("system")}
            onFocus={() => preload("system")}
            onPointerDown={() => preload("system")}
            onClick={() => openArea("/system")}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            <Activity aria-hidden="true" className="size-4" />
            System
          </button>
          <button
            type="button"
            onPointerEnter={() => preload("settings")}
            onFocus={() => preload("settings")}
            onPointerDown={() => preload("settings")}
            onClick={() => openArea("/settings/general")}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            <Settings aria-hidden="true" className="size-4" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false);
              onOpenPalette();
            }}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            <Search aria-hidden="true" className="size-4" />
            Search
          </button>
          <button
            type="button"
            onClick={() => {
              setTheme(theme === "dark" ? "light" : "dark");
              setMoreOpen(false);
            }}
            className="flex min-h-11 items-center rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            Switch to {theme === "dark" ? "light" : "dark"} theme
          </button>
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false);
              shellSwitch.request();
            }}
            className="flex min-h-11 items-center rounded-md px-3 text-left text-fg hover:bg-sunken"
          >
            Switch to classic Mission Control
          </button>
        </div>
      </Sheet>
      <ScopeSwitcher open={scopeOpen} onOpenChange={setScopeOpen} returnFocusRef={moreButton} hideTrigger />
      {shellSwitch.feedback}
    </>
  );
}
