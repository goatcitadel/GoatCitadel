import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Inbox,
  LayoutGrid,
  Library,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from "lucide-react";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { queryKeys } from "../data/query-keys";
import {
  inboxCountLabel,
  inboxCountTitle,
  inboxMatchesWorkspace,
  inboxNavigationLabel,
} from "../areas/inbox/inbox-presentation";
import { useOperatorInbox } from "../data/use-operator-inbox";
import { WorkRunningIndicator } from "./WorkRunningIndicator";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/Menu";
import { COCKPIT_AREAS } from "./routes";
import { useCockpitRoute } from "./use-cockpit-route";
import { useCockpitPreload } from "./use-cockpit-preload";
import { useHealthDigestStatus } from "./use-health-digest";
import { HEALTH_TONE_BG, STREAM_STATUS } from "./stream-status";

const AREA_ICONS = { chat: MessageSquare, inbox: Inbox, work: LayoutGrid, library: Library, system: Activity } as const;

export function Sidebar({
  onOpenPalette,
  streamState,
  collapsed = false,
  onToggleCollapsed,
}: {
  onOpenPalette: () => void;
  streamState: EventStreamConnectionState;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const shellSwitch = useCockpitShellSwitch();
  const { area: current, navigate } = useCockpitRoute();
  const preload = useCockpitPreload();
  const { activeCitadelId, activeWorkspaceId, theme, setTheme } = useUiPreferences();
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(activeCitadelId),
    queryFn: () => fetchWorkspaces("active", 200, activeCitadelId),
  });
  const workspaceId = activeWorkspaceId ?? "default";
  // NV-09: the four-read digest, not the full System › Health fan-out.
  const healthStatus = useHealthDigestStatus(workspaceId, true);
  const inbox = useOperatorInbox(workspaceId);
  const inboxCount = inboxCountLabel(
    !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined,
  );
  const workspaceName =
    workspaces.data?.items.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? "Workspace";
  const stream = STREAM_STATUS[streamState];

  return (
    <aside
      aria-label="Cockpit sidebar"
      data-collapsed={collapsed}
      className={`hidden shrink-0 flex-col gap-1 border-r border-line-subtle bg-raised p-2 sm:flex ${collapsed ? "w-14" : "w-62"}`}
    >
      <ScopeSwitcher compact={collapsed} workspaceName={workspaceName} />
      <IconButton
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        icon={
          collapsed ? (
            <PanelLeftOpen aria-hidden="true" className="size-4" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="size-4" />
          )
        }
      />
      <button
        type="button"
        aria-label="Search commands and records"
        title="Search (Ctrl / Cmd K)"
        onClick={onOpenPalette}
        className="mb-2 flex h-8 items-center gap-2 rounded-md border border-line px-2 text-sm text-fg-muted hover:border-line-strong"
      >
        <Search aria-hidden="true" className="size-4" />
        {!collapsed ? (
          <>
            <span className="flex-1 text-left">Search</span>
            <Kbd>Ctrl / Cmd K</Kbd>
          </>
        ) : null}
      </button>
      <nav aria-label="Areas" className="flex flex-col gap-0.5">
        {COCKPIT_AREAS.map((entry) => {
          const Icon = AREA_ICONS[entry.area];
          return (
            <button
              key={entry.area}
              type="button"
              aria-label={entry.area === "inbox" ? inboxNavigationLabel(inboxCount) : entry.label}
              title={`${entry.label} (g then ${entry.shortcut})`}
              aria-current={current === entry.area ? "page" : undefined}
              aria-describedby={entry.area === "work" ? "cockpit-work-running-summary" : undefined}
              onClick={() => navigate(entry.path)}
              onPointerEnter={() => preload(entry.area)}
              onFocus={() => preload(entry.area)}
              onPointerDown={() => preload(entry.area)}
              className="relative flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-secondary hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:text-fg"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className={collapsed ? "sr-only" : "flex-1 text-left"}>{entry.label}</span>
              {entry.area === "work" ? <WorkRunningIndicator workspaceId={workspaceId} overlay={collapsed} /> : null}
              {entry.area === "inbox" && inboxCount ? (
                <span
                  aria-hidden="true"
                  title={inboxCountTitle(inboxCount)}
                  className={
                    collapsed
                      ? "absolute -top-1 right-0 min-w-4 rounded-full bg-accent px-0.5 text-center text-xs font-semibold text-accent-ink"
                      : "rounded-full border border-line bg-sunken px-1.5 text-xs font-medium text-fg"
                  }
                >
                  {inboxCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div className="flex-1" />
      {healthStatus.phase === "unavailable" ? (
        <div className={`flex items-center gap-2 py-1 text-xs text-fg-muted ${collapsed ? "flex-col" : "px-2"}`}>
          <span aria-hidden="true" className="size-2 rounded-full bg-status-neutral" />
          <span className={collapsed ? "sr-only" : "flex-1"}>{healthStatus.label}</span>
          <Button size="sm" variant="ghost" onClick={healthStatus.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <a
          href="/system"
          title={healthStatus.title}
          onPointerEnter={() => preload("system")}
          onFocus={() => preload("system")}
          onClick={(event) => {
            event.preventDefault();
            navigate("/system");
          }}
          className="flex items-center gap-2 px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          <span aria-hidden="true" className={`size-2 rounded-full ${HEALTH_TONE_BG[healthStatus.tone]}`} />
          <span className={collapsed ? "sr-only" : ""}>{healthStatus.label}</span>
        </a>
      )}
      <div className={`flex items-center gap-2 py-1.5 text-xs text-fg-muted ${collapsed ? "flex-col" : "px-2"}`}>
        <span aria-hidden="true" className={`size-2 rounded-full ${stream.tone}`} />
        <span className={collapsed ? "sr-only" : "flex-1"}>{stream.label}</span>
        <Menu>
          <MenuTrigger
            aria-label="Settings and account"
            className="rounded-md p-1 text-fg-muted hover:bg-sunken"
            onPointerEnter={() => preload("settings")}
            onFocus={() => preload("settings")}
            onPointerDown={() => preload("settings")}
          >
            <Settings aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => navigate("/settings/general")}>Settings</MenuItem>
            <MenuItem onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}>
              Switch to {theme === "dark" ? "light" : "dark"} theme
            </MenuItem>
            <MenuItem onSelect={shellSwitch.request}>Switch to classic Mission Control</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {shellSwitch.feedback}
    </aside>
  );
}
