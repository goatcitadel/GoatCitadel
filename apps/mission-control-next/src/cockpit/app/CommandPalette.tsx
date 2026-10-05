import { Command } from "cmdk";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLlmConfig } from "@goatcitadel/mission-control-shared/api/platform";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildSettingsIndex } from "../areas/settings/settings-index";
import { resourceTitle } from "../areas/library/library-resources";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { COCKPIT_AREAS } from "./routes";
import { useCockpitRoute } from "./use-cockpit-route";
import { useInspector } from "./inspector";
import { useCommandPaletteSearch } from "./use-command-palette-search";
import { useCommandNewChat } from "./use-command-new-chat";
import { useWorkspaceName } from "../data/use-workspace-name";
import { lastVersionNote, recordView } from "../data/record-view";
import {
  CommandPaletteCoverage,
  CommandPaletteResults,
  PALETTE_ITEM_CLASS,
  PaletteResourcePreview,
} from "./CommandPaletteResults";
import type { PaletteObject } from "./command-palette-search";

const SETTINGS = buildSettingsIndex().flatMap((page) => page.entries);

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const shellSwitch = useCockpitShellSwitch();
  const { navigate, requestTransition } = useCockpitRoute();
  const inspector = useInspector();
  const { theme, setTheme, density, setDensity, activeWorkspaceId, activeCitadelId } = useUiPreferences();
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
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  function selectObject(item: PaletteObject) {
    run(() => {
      if ("href" in item.target) navigate(item.target.href);
      else
        inspector.open({
          source: "palette-resource",
          title: resourceTitle(item.target.resource),
          body: <PaletteResourcePreview resource={item.target.resource} scope={scope} />,
        });
    });
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        description="Find commands, workspace conversations, Inbox items, and Library records."
      >
        <Command label="Search or run a command" shouldFilter={false} className="flex min-w-0 flex-col">
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            maxLength={200}
            placeholder="Search or run a command"
            className="h-10 min-w-0 border-b border-line-subtle bg-transparent px-3 text-base text-fg outline-none"
          />
          <p className="px-3 py-2 text-xs text-fg-muted">
            {activeWorkspaceId ? `Workspace: ${workspaceName ?? "current workspace"}.` : "No workspace selected."} Type
            at least two characters to search records. Installation shared results are labeled.
          </p>
          {visibleAttempt ? (
            <div role="status" className="mb-2 px-3 text-sm text-fg-secondary">
              <p>{visibleAttempt.message}</p>
              {visibleAttempt.state === "confirmed" && visibleAttempt.sessionId ? (
                <Button
                  size="sm"
                  onClick={() =>
                    run(() =>
                      navigate(
                        `/chat?${new URLSearchParams({ shell: "cockpit", sessionId: visibleAttempt.sessionId! })}`,
                      ),
                    )
                  }
                >
                  Open created conversation
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="max-h-80 overflow-y-auto p-1">
            <Command.List aria-busy={search.loading}>
              <Command.Group heading="Commands" className="text-xs text-fg-muted">
                {matches("New chat conversation") ? (
                  <Command.Item
                    value="new-chat"
                    disabled={newChat.blocked || !activeWorkspaceId || !activeCitadelId}
                    onSelect={() => {
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
                    }}
                    className={PALETTE_ITEM_CLASS}
                  >
                    New chat
                    <span className="block text-xs text-fg-secondary">
                      Create one conversation in this workspace; nothing is sent.
                    </span>
                  </Command.Item>
                ) : null}
                {matches("Choose default model provider models switch") ? (
                  <Command.Item
                    value="choose-model"
                    onSelect={() => run(() => navigate("/settings/models?shell=cockpit#providers"))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Choose default model…
                    <span className="block break-words text-xs text-fg-secondary">
                      {currentConfig
                        ? `Gateway default: ${currentConfig.activeProviderId} / ${currentConfig.activeModel}.${configAge ? ` ${configAge}` : ""}`
                        : config.isError
                          ? "Gateway default unavailable."
                          : "Reading Gateway default…"}{" "}
                      Opens reviewed Settings. Conversation overrides stay in Chat.
                    </span>
                  </Command.Item>
                ) : null}
              </Command.Group>
              <Command.Group heading="Go to" className="text-xs text-fg-muted">
                {COCKPIT_AREAS.filter((entry) => matches(`Go to ${entry.label}`)).map((entry) => (
                  <Command.Item
                    key={entry.area}
                    value={`go-${entry.area}`}
                    onSelect={() => run(() => navigate(`${entry.path}?shell=cockpit`))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Go to {entry.label}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Preferences" className="text-xs text-fg-muted">
                {matches("Switch theme light dark") ? (
                  <Command.Item
                    value="theme"
                    onSelect={() => run(() => setTheme(theme === "dark" ? "light" : "dark"))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Switch to {theme === "dark" ? "light" : "dark"} theme
                  </Command.Item>
                ) : null}
                {matches("Switch density comfortable compact") ? (
                  <Command.Item
                    value="density"
                    onSelect={() => run(() => setDensity(density === "compact" ? "comfortable" : "compact"))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Switch to {density === "compact" ? "comfortable" : "compact"} density
                  </Command.Item>
                ) : null}
                {matches("Switch to classic Mission Control") ? (
                  <Command.Item
                    value="classic"
                    onSelect={() => run(shellSwitch.request)}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Switch to classic Mission Control
                  </Command.Item>
                ) : null}
              </Command.Group>
              <Command.Group heading="Settings" className="text-xs text-fg-muted">
                {SETTINGS.filter((entry) => matches(`${entry.label} ${entry.searchTerms}`)).map((entry) => (
                  <Command.Item
                    key={entry.section}
                    value={`settings-${entry.section}`}
                    onSelect={() => run(() => navigate(entry.href))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    Settings · {entry.label}
                  </Command.Item>
                ))}
              </Command.Group>
              <CommandPaletteResults groups={search.groups} onSelect={selectObject} />
            </Command.List>
            {search.loading ? (
              <p role="status" className="px-3 py-2 text-sm text-fg-secondary">
                Searching current owners…
              </p>
            ) : null}
            {search.error ? (
              <p role="alert" className="px-3 py-2 text-sm text-fg-secondary">
                Search unavailable: {search.error}
              </p>
            ) : null}
            <CommandPaletteCoverage groups={search.groups} />
          </div>
        </Command>
      </Dialog>
      {shellSwitch.feedback}
    </>
  );
}
