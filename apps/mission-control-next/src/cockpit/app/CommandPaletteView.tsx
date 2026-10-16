import { Command } from "cmdk";
import type { ReactNode, Ref } from "react";
import { CommandPaletteCoverage, CommandPaletteResults, PALETTE_ITEM_CLASS } from "./CommandPaletteResults";
import type { PaletteObject } from "./command-palette-search";
import type { useCommandPaletteSearch } from "./use-command-palette-search";
import { TechnicalDetails } from "../ui/TechnicalDetails";
export { PaletteResourcePreview } from "./CommandPaletteResults";
export interface CommandPaletteViewProps {
  query: string;
  setQuery: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
  activeWorkspaceId: string | null | undefined;
  workspaceName: string | null | undefined;
  creationNotice: ReactNode;
  newChatBlocked: boolean;
  modelSummary: string;
  matches: (text: string) => boolean;
  commandMatches: boolean;
  preferenceMatches: boolean;
  noMatches: boolean;
  destinations: { area: string; label: string; path: string }[];
  settingsMatches: { section: string; label: string; href: string; releaseStatus?: string }[];
  theme: string;
  density: string;
  search: ReturnType<typeof useCommandPaletteSearch>;
  onNewChat: () => void;
  onChooseModel: () => void;
  onTheme: () => void;
  onDensity: () => void;
  onClassic: () => void;
  onDestination: (path: string) => void;
  onSetting: (href: string) => void;
  selectObject: (item: PaletteObject) => void;
}
/** Presentation only. State, reads, uncertainty and all dispatch callbacks remain in CommandPalette. */
export function CommandPaletteView({
  query,
  setQuery,
  inputRef,
  activeWorkspaceId,
  workspaceName,
  creationNotice,
  newChatBlocked,
  modelSummary,
  matches,
  commandMatches,
  preferenceMatches,
  noMatches,
  destinations,
  settingsMatches,
  theme,
  density,
  search,
  onNewChat,
  onChooseModel,
  onTheme,
  onDensity,
  onClassic,
  onDestination,
  onSetting,
  selectObject,
}: CommandPaletteViewProps) {
  return (
    <Command label="Search or run a command" shouldFilter={false} className="flex min-w-0 flex-col">
      <Command.Input
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        maxLength={200}
        placeholder="Search or run a command"
        className="h-10 min-w-0 border-b border-line-subtle bg-transparent px-3 text-base text-fg outline-none"
      />
      <p className="px-3 py-2 text-xs text-fg-muted">
        {activeWorkspaceId ? `Workspace: ${workspaceName ?? "current workspace"}.` : "No workspace selected."} Type at
        least two characters to search.
      </p>
      {creationNotice}
      <div className="max-h-80 overflow-y-auto p-1">
        <Command.List aria-busy={search.loading}>
          {/* cmdk overrides a `hidden` prop on Group, so an empty group is left out instead of hidden. */}
          {commandMatches ? (
            <Command.Group heading="Commands" className="text-xs text-fg-muted">
              {matches("New chat conversation") ? (
                <Command.Item
                  value="new-chat"
                  disabled={newChatBlocked}
                  onSelect={onNewChat}
                  className={PALETTE_ITEM_CLASS}
                >
                  New chat
                  <span className="block text-xs text-fg-secondary">
                    Create one conversation in this workspace; nothing is sent.
                  </span>
                </Command.Item>
              ) : null}
              {matches("Choose default model provider models switch") ? (
                <Command.Item value="choose-model" onSelect={onChooseModel} className={PALETTE_ITEM_CLASS}>
                  Choose default model…
                  <span className="block break-words text-xs text-fg-secondary">
                    {modelSummary} {"Opens reviewed Settings. Conversation overrides stay in Chat."}
                  </span>
                </Command.Item>
              ) : null}
            </Command.Group>
          ) : null}
          {destinations.length ? (
            <Command.Group heading="Go to" className="text-xs text-fg-muted">
              {destinations.map((entry) => (
                <Command.Item
                  key={entry.area}
                  value={`go-${entry.area}`}
                  onSelect={() => onDestination(entry.path)}
                  className={PALETTE_ITEM_CLASS}
                >
                  Go to {entry.label}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {preferenceMatches ? (
            <Command.Group heading="Preferences" className="text-xs text-fg-muted">
              {matches("Switch theme light dark") ? (
                <Command.Item value="theme" onSelect={onTheme} className={PALETTE_ITEM_CLASS}>
                  Switch to {theme === "dark" ? "light" : "dark"} theme
                </Command.Item>
              ) : null}
              {matches("Switch density comfortable compact") ? (
                <Command.Item value="density" onSelect={onDensity} className={PALETTE_ITEM_CLASS}>
                  Switch to {density === "compact" ? "comfortable" : "compact"} density
                </Command.Item>
              ) : null}
              {matches("Switch to classic Mission Control") ? (
                <Command.Item value="classic" onSelect={onClassic} className={PALETTE_ITEM_CLASS}>
                  Switch to classic Mission Control
                </Command.Item>
              ) : null}
            </Command.Group>
          ) : null}
          {settingsMatches.length ? (
            <Command.Group heading="Settings" className="text-xs text-fg-muted">
              {settingsMatches.map((entry) => (
                <Command.Item
                  key={entry.section}
                  value={`settings-${entry.section}`}
                  onSelect={() => onSetting(entry.href)}
                  className={PALETTE_ITEM_CLASS}
                >
                  Settings · {entry.label}
                  {entry.releaseStatus === "experimental" ? " · Experimental" : ""}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          <CommandPaletteResults groups={search.groups} onSelect={selectObject} />
        </Command.List>
        {noMatches ? (
          <p role="status" className="px-3 py-2 text-sm text-fg-secondary">
            No matching commands or returned records. Try a destination such as Settings, approvals, health, or a
            different search term.
          </p>
        ) : null}
        {search.loading ? (
          <p role="status" className="px-3 py-2 text-sm text-fg-secondary">
            Searching…
          </p>
        ) : null}
        {search.error ? (
          <div role="alert" className="space-y-1 px-3 py-2 text-sm text-fg-secondary">
            <p>Search didn't respond. Try again.</p>
            <TechnicalDetails>{search.error}</TechnicalDetails>
          </div>
        ) : null}
        <CommandPaletteCoverage groups={search.groups} />
      </div>
    </Command>
  );
}
