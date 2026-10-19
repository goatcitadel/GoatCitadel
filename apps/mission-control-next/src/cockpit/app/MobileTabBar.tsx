import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useRef, useState } from "react";
import {
  Activity,
  Inbox,
  LayoutGrid,
  Library,
  MessageSquare,
  MoreHorizontal,
  Search,
  Settings,
  TriangleAlert,
} from "lucide-react";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { otherThemeOptions } from "./theme-options";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { inboxCountLabel, inboxMatchesWorkspace, inboxNavigationLabel } from "../areas/inbox/inbox-presentation";
import { InboxCountBadge } from "./InboxCountBadge";
import { useOperatorInbox } from "../data/use-operator-inbox";
import { useCockpitNavigation } from "./cockpit-navigation-context";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { Sheet } from "../ui/Sheet";
import { useCockpitRoute } from "./use-cockpit-route";
import { useCockpitPreload } from "./use-cockpit-preload";
import { MobileStatusStrip } from "./MobileStatusStrip";
import { statusNeedsAttention } from "./stream-status";
import { useHealthDigestStatus } from "./use-health-digest";
import { WorkRunningIndicator } from "./WorkRunningIndicator";
import { useWorkspaceName } from "../data/use-workspace-name";
import { useCitadelName } from "../data/use-citadel-name";
import { TechnicalDetails } from "../ui/TechnicalDetails";
import { isModifiedClick } from "../lib/modified-click";

const TABS = [
  { area: "chat", label: "Chat", path: "/chat", Icon: MessageSquare },
  { area: "inbox", label: "Inbox", path: "/inbox", Icon: Inbox },
  { area: "work", label: "Work", path: "/work", Icon: LayoutGrid },
  { area: "library", label: "Library", path: "/library", Icon: Library },
] as const;

export function MobileTabBar({
  onOpenPalette,
  streamState = "closed",
}: {
  onOpenPalette: () => void;
  streamState?: EventStreamConnectionState;
}) {
  // The status strip and the Work count read only on phones, where the sidebar is not rendered.
  const phone = !useMediaQuery(RESPONSIVE_QUERIES.abovePhone);
  const { isTransitionPending } = useCockpitNavigation();
  const shellSwitch = useCockpitShellSwitch();
  const { area: current, navigate } = useCockpitRoute();
  const preload = useCockpitPreload();
  const { activeWorkspaceId, activeCitadelId, themePreference, setTheme } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const workspaceName = useWorkspaceName(activeCitadelId, activeWorkspaceId, phone);
  const citadelName = useCitadelName(activeCitadelId, phone);
  const inbox = useOperatorInbox(workspaceId);
  // SH-01: the phone has no status row; the More tab carries a shaped marker when status needs a look.
  const health = useHealthDigestStatus(workspaceId, phone, true);
  const attention = phone && statusNeedsAttention(health.tone, streamState);
  const scopeLine = citadelName.startsWith("Reading Citadel")
    ? "Loading workspace…"
    : `${citadelName} / ${workspaceName ?? "Workspace"}`;
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
      {/* SH-22: the bottom chrome is the tab bar only; scope and status live at the top of the More sheet. */}
      <div className="cockpit-safe-bottom shrink-0 border-t border-line-subtle bg-raised sm:hidden">
        <nav aria-label="Areas on small screens" data-cockpit-tabbar="" className="flex">
          {TABS.map(({ area, label, path, Icon }) => (
            <a
              key={area}
              href={path}
              aria-current={current === area ? "page" : undefined}
              aria-label={area === "inbox" && inboxCount ? inboxNavigationLabel(inboxCount) : undefined}
              aria-describedby={area === "work" && phone ? "cockpit-work-running-summary" : undefined}
              onClick={(event) => {
                // SH-28: a real link, so a modified click or long-press menu can open the area in a new tab.
                if (isModifiedClick(event)) return;
                event.preventDefault();
                navigate(path);
              }}
              onPointerEnter={() => preload(area)}
              onFocus={() => preload(area)}
              onPointerDown={() => preload(area)}
              className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs text-fg-muted aria-[current=page]:text-fg"
            >
              <span className="relative">
                <Icon aria-hidden="true" className="size-5" />
                {area === "inbox" && inboxCount ? (
                  <InboxCountBadge count={inboxCount} className="absolute -right-3 -top-1" />
                ) : null}
                {area === "work" && phone ? (
                  <span className="absolute -right-3 -top-1">
                    <WorkRunningIndicator workspaceId={workspaceId} showCount />
                  </span>
                ) : null}
              </span>
              {label}
            </a>
          ))}
          <button
            ref={moreButton}
            type="button"
            aria-label="More areas and settings"
            aria-expanded={moreOpen}
            aria-current={current === "system" || current === "settings" ? "page" : undefined}
            aria-describedby={attention ? "cockpit-more-attention" : undefined}
            onClick={() => {
              if (!isTransitionPending()) setMoreOpen(true);
            }}
            className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs text-fg-muted"
          >
            <span className="relative">
              <MoreHorizontal aria-hidden="true" className="size-5" />
              {attention ? (
                <TriangleAlert
                  aria-hidden="true"
                  data-status-attention=""
                  className="absolute -right-3 -top-1 size-3.5 text-status-waiting"
                />
              ) : null}
            </span>
            {/* Stays "More" so the visible text is part of the accessible name; aria-current marks System/Settings. */}
            More
          </button>
        </nav>
        {attention ? (
          <span id="cockpit-more-attention" className="sr-only">
            System status needs attention
          </span>
        ) : null}
      </div>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="More">
        {phone ? (
          <MobileStatusStrip
            workspaceId={workspaceId}
            streamState={streamState}
            onOpenHealth={() => openArea("/system/health")}
          />
        ) : null}
        <p aria-label="Current operating scope" className="truncate px-3 text-sm text-fg-secondary">
          {scopeLine}
        </p>
        <TechnicalDetails label="Operating scope identifiers">
          <p>Citadel: {activeCitadelId}</p>
          <p>Workspace: {workspaceId}</p>
        </TechnicalDetails>
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
          {otherThemeOptions(themePreference).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setTheme(option.value);
                setMoreOpen(false);
              }}
              className="flex min-h-11 items-center rounded-md px-3 text-left text-fg hover:bg-sunken"
            >
              {option.action}
            </button>
          ))}
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
