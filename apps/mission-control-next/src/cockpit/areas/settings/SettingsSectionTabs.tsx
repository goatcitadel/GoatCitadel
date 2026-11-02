import { Suspense, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { readCockpitLocation } from "../../app/cockpit-back-guard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs";
import type { SettingsIndexEntry, SettingsIndexPage } from "./settings-index";
import { preloadSettingsSection } from "./settings-controls";
import { describeReleaseSurfaceStatus } from "../../../app/route-model";
import { useOverflowEdges } from "./use-overflow-edges";
import { isMcpOAuthReturnFragment } from "../../../features/native-routes/settings/mcp-oauth-return";
import { isGoogleOAuthReturnFragment } from "../../../features/native-routes/settings/google-oauth-return";

const DEFAULT_SECTIONS: Record<string, string> = {
  models: "providers",
  citadel: "workspaces",
};

function subscribe(onChange: () => void) {
  for (const event of ["popstate", "hashchange", "goatcitadel:cockpit-location"])
    window.addEventListener(event, onChange);
  return () => {
    for (const event of ["popstate", "hashchange", "goatcitadel:cockpit-location"])
      window.removeEventListener(event, onChange);
  };
}

/** Hash changes must be observed even when the containing cockpit route is unchanged. */
export function useSettingsSectionHash() {
  return useSyncExternalStore(
    subscribe,
    () => readCockpitLocation().hash.slice(1),
    () => "",
  );
}

export function selectedSettingsSection(page: SettingsIndexPage, routeSection: string | undefined, hash: string) {
  const aliasedHash =
    hash === "application-updates"
      ? "appearance"
      : hash === "approval-mode" ||
          hash === "browser-errands" ||
          hash === "filesystem-write-roots" ||
          hash === "settings-approval-skip"
        ? "tools"
        : hash === "claude-cli-tool-bridge" ||
            hash === "claude-cli-warm-continuation" ||
            hash === "chat-thinking-stream"
          ? "providers"
          : // A provider sign-in lands on Capabilities › Connectors › Advanced setup; the MCP section must mount so it
            // can hand the result back.
            isMcpOAuthReturnFragment(hash)
            ? "mcp"
            : // Google sign-in lands there too; Integrations mounts the saved connection that finishes it.
              isGoogleOAuthReturnFragment(hash)
              ? "integrations"
              : hash;
  return (
    page.entries.find((entry) => entry.anchor === aliasedHash || entry.section === aliasedHash)?.section ??
    page.entries.find((entry) => entry.section === routeSection)?.section ??
    DEFAULT_SECTIONS[page.id] ??
    page.entries[0]!.section
  );
}

export function SettingsSectionTabs({
  page,
  value,
  onChange,
  children,
}: {
  page: SettingsIndexPage;
  value: string;
  onChange: (entry: SettingsIndexEntry) => void;
  children: (entry: SettingsIndexEntry) => ReactNode;
}) {
  // Keep visited controls (and unsaved input) without mounting every hidden owner.
  const visited = useRef(new Set<string>());
  visited.current.add(value);
  // A long section row (Citadel has nine) scrolls sideways; the hidden side fades and the selected tab stays in view.
  const root = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(root, '[role="tablist"]', page.id);
  useEffect(() => {
    root.current
      ?.querySelector('[role="tablist"] [data-state="active"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);
  const discoverable = page.entries.filter((entry) => entry.discoverable);
  if (discoverable.length <= 1) {
    const entry = page.entries.find((item) => item.section === value) ?? discoverable[0] ?? page.entries[0];
    return entry ? (
      <section aria-label={entry.tabLabel ?? entry.label} className="mt-3 min-w-0">
        <SectionBody entry={entry}>{children}</SectionBody>
      </section>
    ) : null;
  }
  return (
    <Tabs
      ref={root}
      value={value}
      onValueChange={(section) => {
        const entry = page.entries.find((item) => item.section === section);
        if (entry) onChange(entry);
      }}
      activationMode="manual"
      className="min-w-0"
    >
      <TabsList
        aria-label={`${page.label} sections`}
        data-overflow-start={edges.start || undefined}
        data-overflow-end={edges.end || undefined}
        className="cockpit-area-tabs cockpit-overflow-fade mt-3 max-w-full gap-0.5 overflow-x-auto rounded-lg border-b-0 bg-sunken p-0.5 sm:w-fit"
      >
        {page.entries
          .filter((entry) => entry.discoverable)
          .map((entry) => (
            <TabsTrigger
              key={entry.section}
              value={entry.section}
              className="min-h-8 shrink-0 whitespace-nowrap rounded-md border-b-0 px-3 py-1 text-xs data-[state=active]:bg-raised"
              onPointerEnter={() => preloadSettingsSection(entry.section)}
              onFocus={() => preloadSettingsSection(entry.section)}
              onPointerDown={() => preloadSettingsSection(entry.section)}
            >
              {entry.tabLabel ?? entry.label}
              {entry.releaseStatus === "experimental" ? " · Experimental" : ""}
            </TabsTrigger>
          ))}
      </TabsList>
      {page.entries.map((entry) => (
        <TabsContent
          key={entry.section}
          value={entry.section}
          forceMount
          // Panels open with a heading or text, not a control, so the tabs pattern keeps them a tab stop.
          tabIndex={0}
          hidden={value !== entry.section}
          aria-label={!entry.discoverable ? entry.label : undefined}
          className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          {visited.current.has(entry.section) ? <SectionBody entry={entry}>{children}</SectionBody> : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** One section's lazy body: its loading line, any release-status note, then the section's controls. */
function SectionBody({
  entry,
  children,
}: {
  entry: SettingsIndexEntry;
  children: (entry: SettingsIndexEntry) => ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="py-3 text-sm text-fg-muted">
          Loading {entry.tabLabel ?? entry.label}…
        </p>
      }
    >
      {entry.releaseStatus !== "ship" ? (
        <p className="py-2 text-sm text-fg-secondary">
          {describeReleaseSurfaceStatus(entry.releaseStatus)}. {entry.releaseNote}
        </p>
      ) : null}
      {children(entry)}
    </Suspense>
  );
}
