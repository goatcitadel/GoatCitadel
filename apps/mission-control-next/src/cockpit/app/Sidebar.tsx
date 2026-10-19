import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Inbox,
  LayoutGrid,
  Library,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Search,
  Settings,
} from "lucide-react";
import { isModifiedClick } from "../lib/modified-click";
import { cockpitHref } from "./cockpit-history";
import { shortcutLabel } from "./platform-keys";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { otherThemeOptions } from "./theme-options";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { queryKeys } from "../data/query-keys";
import { inboxCountLabel, inboxMatchesWorkspace, inboxNavigationLabel } from "../areas/inbox/inbox-presentation";
import { InboxCountBadge } from "./InboxCountBadge";
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
import { HEALTH_TONE_ICON, presentCockpitStream } from "./stream-status";
import { Tooltip } from "../ui/Tooltip";

const AREA_ICONS = { chat: MessageSquare, inbox: Inbox, work: LayoutGrid, library: Library, system: Activity } as const;

export function Sidebar({
  onOpenPalette,
  streamState,
  replayRecovery = false,
  collapsed = false,
  onToggleCollapsed,
}: {
  onOpenPalette: () => void;
  streamState: EventStreamConnectionState;
  replayRecovery?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const shellSwitch = useCockpitShellSwitch();
  const { area: current, pathname, search, hash, navigate } = useCockpitRoute();
  const preload = useCockpitPreload();
  const { activeCitadelId, activeWorkspaceId, themePreference, setTheme } = useUiPreferences();
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(activeCitadelId),
    queryFn: () => fetchWorkspaces("active", 200, activeCitadelId),
  });
  const workspaceId = activeWorkspaceId ?? "default";
  // NV-09: the four-read digest, not the full System › Health fan-out.
  const healthStatus = useHealthDigestStatus(workspaceId, true, true);
  const inbox = useOperatorInbox(workspaceId);
  const inboxCount = inboxCountLabel(
    !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined,
  );
  const workspaceName =
    workspaces.data?.items.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? "Workspace";
  const stream = presentCockpitStream(streamState, replayRecovery);
  // SH-01: status icons differ in shape per tone, so the rail never relies on colour alone.
  const { Icon: HealthIcon, text: healthText } = HEALTH_TONE_ICON[healthStatus.tone];
  const { Icon: StreamIcon, text: streamText } = stream;

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
        title={`Search (${shortcutLabel("k")})`}
        onClick={onOpenPalette}
        className="mb-2 flex h-8 items-center gap-2 rounded-md border border-line-control px-2 text-sm text-fg-muted hover:border-fg"
      >
        <Search aria-hidden="true" className="size-4" />
        {!collapsed ? (
          <>
            <span className="flex-1 text-left">Search</span>
            <Kbd>{shortcutLabel("k")}</Kbd>
          </>
        ) : null}
      </button>
      <nav aria-label="Areas" className="flex flex-col gap-0.5">
        {COCKPIT_AREAS.map((entry) => {
          const Icon = AREA_ICONS[entry.area];
          return (
            <a
              key={entry.area}
              // The canonical cockpit URL, so a new tab opens Cockpit even when the saved shell is Classic.
              href={cockpitHref(entry.path) ?? entry.path}
              aria-label={entry.area === "inbox" ? inboxNavigationLabel(inboxCount) : entry.label}
              title={`${entry.label} (g then ${entry.shortcut})`}
              aria-current={current === entry.area ? "page" : undefined}
              aria-describedby={entry.area === "work" ? "cockpit-work-running-summary" : undefined}
              onClick={(event) => {
                // SH-28: a real link, so Ctrl/Cmd-click and middle-click open the area in a new tab.
                if (isModifiedClick(event)) return;
                event.preventDefault();
                navigate(entry.path);
              }}
              onPointerEnter={() => preload(entry.area)}
              onFocus={() => preload(entry.area)}
              onPointerDown={() => preload(entry.area)}
              className="relative flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-secondary hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:text-fg"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className={collapsed ? "sr-only" : "flex-1 text-left"}>{entry.label}</span>
              {entry.area === "work" ? <WorkRunningIndicator workspaceId={workspaceId} overlay={collapsed} /> : null}
              {entry.area === "inbox" && inboxCount ? (
                <InboxCountBadge count={inboxCount} className={collapsed ? "absolute -top-1 right-0" : ""} />
              ) : null}
            </a>
          );
        })}
      </nav>
      <div className="flex-1" />
      {healthStatus.phase === "unavailable" ? (
        <div className={`flex items-center gap-2 py-1 text-xs text-fg-muted ${collapsed ? "flex-col" : "px-2"}`}>
          <HealthIcon aria-hidden="true" className={`size-4 shrink-0 ${healthText}`} />
          <span className={collapsed ? "sr-only" : "flex-1"}>{healthStatus.label}</span>
          {collapsed ? (
            <IconButton
              label="Retry system checks"
              icon={<RotateCw aria-hidden="true" className="size-4" />}
              onClick={healthStatus.retry}
            />
          ) : (
            <Button size="sm" variant="ghost" aria-label="Retry system checks" onClick={healthStatus.retry}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        <a
          href={cockpitHref("/system") ?? "/system"}
          title={healthStatus.title}
          onPointerEnter={() => preload("system")}
          onFocus={() => preload("system")}
          onClick={(event) => {
            if (isModifiedClick(event)) return;
            event.preventDefault();
            navigate("/system");
          }}
          className="flex items-center gap-2 px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          <HealthIcon aria-hidden="true" className={`size-4 shrink-0 ${healthText}`} />
          <span className={collapsed ? "sr-only" : ""}>{healthStatus.label}</span>
        </a>
      )}
      <div
        data-stream-state={streamState}
        aria-label={stream.ariaLabel}
        className={`flex items-center gap-2 py-1.5 text-xs text-fg-muted ${collapsed ? "flex-col" : "px-2"}`}
      >
        {collapsed ? (
          // The collapsed rail hides the label, so the icon is focusable and names itself in a tooltip.
          <Tooltip label={stream.label}>
            <span tabIndex={0} role="img" aria-label={stream.label} className="inline-flex rounded-sm">
              <StreamIcon aria-hidden="true" className={`size-4 ${streamText}`} />
            </span>
          </Tooltip>
        ) : (
          <>
            <StreamIcon aria-hidden="true" className={`size-4 shrink-0 ${streamText}`} />
            <span className="flex-1">{stream.label}</span>
          </>
        )}
        <Menu scopeKey={JSON.stringify([activeCitadelId, activeWorkspaceId, pathname, search, hash])}>
          <MenuTrigger
            aria-label="Settings and account"
            // ST-11: Settings has no Areas entry, so its gear is the sidebar's current item while Settings is open.
            aria-current={current === "settings" ? "page" : undefined}
            className="rounded-md p-1 text-fg-muted hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:text-fg"
            onPointerEnter={() => preload("settings")}
            onFocus={() => preload("settings")}
            onPointerDown={() => preload("settings")}
          >
            <Settings aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => navigate("/settings/general")}>Settings</MenuItem>
            {otherThemeOptions(themePreference).map((option) => (
              <MenuItem key={option.value} onSelect={() => setTheme(option.value)}>
                {option.action}
              </MenuItem>
            ))}
            <MenuItem onSelect={shellSwitch.request}>Switch to classic Mission Control</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {shellSwitch.feedback}
    </aside>
  );
}
