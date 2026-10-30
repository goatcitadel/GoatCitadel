import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLlmConfig } from "@goatcitadel/mission-control-shared/api/platform";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { useUiPreferences, type UiTheme } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { THEME_SEARCH_TERMS } from "./theme-options";
import { buildSettingsIndex } from "../areas/settings/settings-index";
import { resourceTitle } from "../areas/library/resource-title";
import { LIBRARY_SECTION_LABELS } from "../areas/library/library-sections";
import { CAPABILITIES_TABS } from "../areas/capabilities/capabilities-tabs";
import { SYSTEM_VIEWS } from "../areas/system/system-views";
import { WORK_VIEWS } from "../areas/work/work-views";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { channelAdvancedSetupHref, COCKPIT_AREAS, connectorSetupHref } from "./routes";
import { useCockpitRoute } from "./use-cockpit-route";
import { useInspector } from "./inspector";
import { useCommandPaletteSearch } from "./use-command-palette-search";
import { useCommandNewChat } from "./use-command-new-chat";
import { useWorkspaceName } from "../data/use-workspace-name";
import { useModelLabel } from "../data/use-model-label";
import { lastVersionNote, recordView } from "../data/record-view";
import { useCommandPaletteViewCode } from "./use-command-palette-view-code";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  chatSessionCreationBlocked,
  chatSessionCreationKey,
  readChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import type { PaletteObject } from "./command-palette-search";

const SETTINGS = buildSettingsIndex({ discovery: true }).flatMap((page) => page.entries);
/** Tabs inside each area, matched on a typed query only so the empty palette stays a short list of areas. */
const TAB_DESTINATIONS = [
  ...SYSTEM_VIEWS.map((view) => ({ area: "system", label: `System › ${view.label}`, path: view.path })),
  ...WORK_VIEWS.map((view) => ({ area: "work", label: `Work › ${view.label}`, path: view.href })),
  ...CAPABILITIES_TABS.map((tab) => ({ area: "capabilities", label: `Capabilities › ${tab.label}`, path: tab.href })),
  ...Object.entries(LIBRARY_SECTION_LABELS).map(([section, label]) => ({
    area: "library",
    label: `Library › ${label}`,
    path: section === "capabilities" ? "/library" : `/library/${section}`,
  })),
]
  .map((entry) => ({ ...entry, key: entry.path, terms: "" }))
  .concat([
    // The two pages that hold what Settings › Connections did, found by the names of the sections they took over.
    {
      area: "capabilities",
      label: "Capabilities › Advanced setup",
      path: connectorSetupHref(),
      key: connectorSetupHref(),
      terms: "settings connections mcp servers integrations web search firecrawl brave parallel api keys",
    },
    {
      area: "chat",
      label: "Chat › Advanced channel setup",
      path: channelAdvancedSetupHref(),
      key: channelAdvancedSetupHref(),
      terms: "settings connections channels messaging public web address webhook",
    },
  ]);
const DESTINATIONS = [
  ...COCKPIT_AREAS.map((entry) => ({
    ...entry,
    key: entry.area,
    terms:
      entry.area === "inbox"
        ? "approvals attention decisions"
        : entry.area === "capabilities"
          ? "skills plugins connectors tools mcp integrations apps install"
          : entry.area === "system"
            ? "health diagnostics status operations"
            : entry.label,
  })),
  {
    area: "settings",
    key: "settings",
    label: "Settings",
    path: "/settings/general",
    terms: "settings preferences account configuration",
  },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const shellSwitch = useCockpitShellSwitch();
  const { navigate, requestTransition } = useCockpitRoute();
  const inspector = useInspector();
  const { themePreference, setTheme, density, setDensity, activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const viewCode = useCommandPaletteViewCode(
    open,
    activeWorkspaceId,
    activeCitadelId,
    () =>
      !hasUnsettledChatContextMutation() &&
      (!activeWorkspaceId ||
        !chatSessionCreationBlocked(
          readChatSessionCreation(chatSessionCreationKey(getGatewayApiBaseUrl(), activeWorkspaceId)),
        )),
  );
  const View = viewCode.View;
  const [query, setQuery] = useState("");
  const scope = { workspaceId: activeWorkspaceId, citadelId: activeCitadelId };
  const search = useCommandPaletteSearch(open, scope, query);
  const config = useQuery({
    queryKey: ["system", "palette-model-default"],
    queryFn: fetchLlmConfig,
    enabled: open,
    staleTime: 0,
  });
  const configView = recordView(config);
  const currentConfig = open ? configView.record : undefined;
  const configAge = lastVersionNote(configView);
  const defaultModelLabel = useModelLabel(currentConfig?.activeProviderId, currentConfig?.activeModel, open);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  const newChat = useCommandNewChat(scope, open, (sessionId) =>
    run(() => navigate(`/chat?${new URLSearchParams({ shell: "cockpit", sessionId })}`)),
  );
  const workspaceName = useWorkspaceName(activeCitadelId, activeWorkspaceId, open && Boolean(activeWorkspaceId));
  // A confirmed creation that was already opened before this palette open is history, not news.
  // Unknown, failed and "opening failed" records stay visible because they prevent duplicates.
  const latestAttempt = useRef(newChat.attempt);
  useLayoutEffect(() => {
    latestAttempt.current = newChat.attempt;
  });
  const [attemptAtOpen, setAttemptAtOpen] = useState<typeof newChat.attempt>(undefined);
  useLayoutEffect(() => {
    setAttemptAtOpen(open ? latestAttempt.current : undefined);
  }, [open]);
  const visibleAttempt =
    newChat.attempt &&
    !(
      newChat.attempt === attemptAtOpen &&
      newChat.attempt.state === "confirmed" &&
      !newChat.attempt.message.includes("Opening it failed")
    )
      ? newChat.attempt
      : undefined;
  // Labels such as "Work › Schedules" are compared as plain words, so "work schedules" matches them.
  const normalizeForMatch = (text: string) => text.replace(/[›»]/gu, " ").replace(/\s+/gu, " ").toLowerCase();
  const matches = (text: string) => normalizeForMatch(text).includes(normalizeForMatch(query).trim());
  // Static destinations are matched here, synchronously; remote records stream in below them.
  const destinations = [...DESTINATIONS, ...(query.trim() ? TAB_DESTINATIONS : [])].filter((entry) =>
    matches(`Go to ${entry.label} ${entry.terms}`),
  );
  const settingsMatches = SETTINGS.filter((entry) => matches(`settings ${entry.label} ${entry.searchTerms}`));
  const commandMatches = matches("New chat conversation") || matches("Choose default model provider models switch");
  const preferenceMatches =
    matches(THEME_SEARCH_TERMS) ||
    matches("Switch density comfortable compact") ||
    matches("Switch to classic Mission Control");
  const noMatches =
    Boolean(query.trim()) &&
    !commandMatches &&
    !preferenceMatches &&
    !destinations.length &&
    !settingsMatches.length &&
    !search.groups.some((group) => group.items.length) &&
    !search.loading;
  const onNewChat = () => {
    requestTransition(async (review) => {
      await newChat.create({
        isCurrent: review.isCurrent,
        onCreated: (sessionId) => {
          if (review.navigate(`/chat?${new URLSearchParams({ shell: "cockpit", sessionId })}`)) {
            onOpenChange(false);
          }
        },
      });
    });
  };
  const onChooseModel = () => run(() => navigate("/settings/models#providers"));
  const onTheme = (next: UiTheme) => run(() => setTheme(next));
  const onDensity = () => run(() => setDensity(density === "compact" ? "comfortable" : "compact"));
  const onClassic = () => run(shellSwitch.request);
  const onDestination = (path: string) => run(() => navigate(path));
  const onSetting = (href: string) => run(() => navigate(href));
  const creationNotice = visibleAttempt ? (
    <div role="status" className="mb-2 px-3 text-sm text-fg-secondary">
      <p>{visibleAttempt.message}</p>
      {visibleAttempt.state === "confirmed" && visibleAttempt.sessionId ? (
        <Button
          ref={viewCode.createdRef}
          data-palette-created="true"
          size="sm"
          onClick={() =>
            run(() =>
              navigate(`/chat?${new URLSearchParams({ shell: "cockpit", sessionId: visibleAttempt.sessionId! })}`),
            )
          }
        >
          Open created conversation
        </Button>
      ) : null}
    </div>
  ) : null;
  const modelSummary = currentConfig
    ? `Default model: ${defaultModelLabel}.${configAge ? ` ${configAge}` : ""}`
    : config.isError
      ? "Default model unavailable."
      : "Reading the default model…";
  function selectObject(item: PaletteObject) {
    run(() => {
      if ("href" in item.target) navigate(item.target.href);
      else {
        const PaletteResourcePreview = viewCode.code?.PaletteResourcePreview;
        if (!PaletteResourcePreview) return;
        inspector.open({
          source: "palette-resource",
          title: resourceTitle(item.target.resource),
          body: <PaletteResourcePreview resource={item.target.resource} scope={scope} />,
        });
      }
    });
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        description="Find commands, workspace conversations, Inbox items, and Library records."
        onOpenAutoFocus={viewCode.onOpenAutoFocus}
      >
        {View ? (
          <View
            query={query}
            setQuery={setQuery}
            inputRef={viewCode.inputRef}
            activeWorkspaceId={activeWorkspaceId}
            workspaceName={workspaceName}
            creationNotice={creationNotice}
            newChatBlocked={newChat.blocked || !activeWorkspaceId || !activeCitadelId}
            modelSummary={modelSummary}
            matches={matches}
            commandMatches={commandMatches}
            preferenceMatches={preferenceMatches}
            noMatches={noMatches}
            destinations={destinations}
            settingsMatches={settingsMatches}
            theme={themePreference}
            density={density}
            search={search}
            onNewChat={onNewChat}
            onChooseModel={onChooseModel}
            onTheme={onTheme}
            onDensity={onDensity}
            onClassic={onClassic}
            onDestination={onDestination}
            onSetting={onSetting}
            selectObject={selectObject}
          />
        ) : (
          <div ref={viewCode.pendingHost} className="flex min-w-0 flex-col">
            <input
              ref={viewCode.inputRef}
              aria-label="Search or run a command"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              maxLength={200}
              onCompositionStart={() => viewCode.setComposing(true)}
              onCompositionEnd={() => viewCode.setComposing(false)}
              onBlur={() => viewCode.setComposing(false)}
              placeholder="Search or run a command"
              className="h-10 min-w-0 border-b border-line-subtle bg-transparent px-3 text-base text-fg outline-none"
            />
            <p className="px-3 py-2 text-xs text-fg-muted">
              {activeWorkspaceId
                ? "Workspace: " + (workspaceName ?? "current workspace") + "."
                : "No workspace selected."}
              {query.trim().length < 2 ? " Type at least two characters to search." : ""}
            </p>
            {creationNotice}
            <p className="px-3 py-2 text-sm text-fg-secondary">
              {modelSummary} Opens Settings to change it. Conversation overrides stay in Chat.
            </p>
            {viewCode.failed ? (
              <div role="alert" className="min-h-24 space-y-2 px-3 py-2 text-sm">
                <p>
                  Command controls could not load. You can close the palette and keep using Cockpit, or reload the app.
                </p>
                <Button
                  size="sm"
                  disabled={!viewCode.reloadAllowed}
                  onClick={(event) => viewCode.openReload(event.currentTarget)}
                >
                  Reload app
                </Button>
                {!viewCode.reloadAllowed ? (
                  <p>
                    {hasUnsettledChatContextMutation()
                      ? CHAT_CONTEXT_RELOAD_NOTE
                      : "A conversation creation is still pending or unconfirmed. Close the palette and inspect conversation history before reloading."}
                  </p>
                ) : null}
              </div>
            ) : (
              <p role="status" className="min-h-24 px-3 py-2 text-sm text-fg-muted">
                Loading command controls…
              </p>
            )}
          </div>
        )}
      </Dialog>
      {viewCode.recovery}
      {shellSwitch.feedback}
    </>
  );
}
