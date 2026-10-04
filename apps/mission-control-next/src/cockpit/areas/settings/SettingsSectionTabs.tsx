import { Suspense, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs";
import type { SettingsIndexEntry, SettingsIndexPage } from "./settings-index";
import { preloadSettingsSection } from "./settings-controls";

const DEFAULT_SECTIONS: Record<string, string> = {
  models: "providers",
  connections: "integrations",
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
    () => window.location.hash.slice(1),
    () => "",
  );
}

export function selectedSettingsSection(page: SettingsIndexPage, routeSection: string | undefined, hash: string) {
  const aliasedHash = hash === "application-updates" ? "appearance" : hash === "approval-mode" ? "tools" : hash;
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
  return (
    <Tabs
      value={value}
      onValueChange={(section) => {
        const entry = page.entries.find((item) => item.section === section);
        if (entry) onChange(entry);
      }}
      activationMode="manual"
      className="min-w-0"
    >
      <TabsList aria-label={`${page.label} sections`} className="mt-3 max-w-full overflow-x-auto pb-px">
        {page.entries.map((entry) => (
          <TabsTrigger
            key={entry.section}
            value={entry.section}
            className="min-h-11 shrink-0 whitespace-nowrap"
            onPointerEnter={() => preloadSettingsSection(entry.section)}
            onFocus={() => preloadSettingsSection(entry.section)}
            onPointerDown={() => preloadSettingsSection(entry.section)}
          >
            {entry.tabLabel ?? entry.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {page.entries.map((entry) => (
        <TabsContent
          key={entry.section}
          value={entry.section}
          forceMount
          hidden={value !== entry.section}
          className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          {visited.current.has(entry.section) ? (
            <Suspense
              fallback={
                <p role="status" className="py-3 text-sm text-fg-muted">
                  Loading {entry.tabLabel ?? entry.label}…
                </p>
              }
            >
              {children(entry)}
            </Suspense>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
