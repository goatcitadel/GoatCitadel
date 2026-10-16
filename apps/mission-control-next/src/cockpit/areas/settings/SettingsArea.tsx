import { Suspense, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Search } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader, AreaTabsProvider } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { EmptyState } from "../../ui/EmptyState";
import { isModifiedClick } from "../../lib/modified-click";
import { buildSettingsIndex, searchSettingsPages, type SettingsIndexEntry } from "./settings-index";
import { SettingsSectionTabs, selectedSettingsSection, useSettingsSectionHash } from "./SettingsSectionTabs";
import {
  FirstRunArea,
  AppearanceSettings,
  DeviceAccessSettings,
  PersonalitySettings,
  WorkspaceSettings,
  IntegrationConnectionsSettings,
  ManagedRuntimeSettings,
  McpServersSettings,
  BudgetModeControl,
  ApprovalModeControl,
  ModelsSettings,
  ToolGrantSettings,
  SafetyCatalogSummary,
  PermissionProfileSettings,
  TrustPolicySettings,
  LocalAiSettings,
  CitadelBlueprintSettings,
  ChannelsSettings,
  CitadelOverviewSettings,
  CitadelMasonSettings,
  CitadelWardsSettings,
  CitadelCouncilSettings,
  CitadelVaultSettings,
  DaemonDiagnostics,
  VoiceRuntimeSettings,
  LlamaSetupSettings,
  CapabilityScopesSettings,
  HooksSettings,
  AddonsSettings,
  PortablePacksSettings,
  preloadSettingsSection,
} from "./settings-controls";

const PAGES = buildSettingsIndex();
const DISCOVERABLE_PAGES = buildSettingsIndex({ discovery: true });
const PAGE_TABS = DISCOVERABLE_PAGES.map((item) => ({ id: item.id, label: item.label, href: `/settings/${item.id}` }));

/** Warm a Settings page's first section when the pointer or focus reaches its tab in the area header. */
function preloadPageTab(target: EventTarget) {
  const href = target instanceof Element ? target.closest("a")?.getAttribute("href") : null;
  const item = DISCOVERABLE_PAGES.find((candidate) => `/settings/${candidate.id}` === href);
  if (item) preloadSettingsSection(selectedSettingsSection(item, item.id, ""));
}

export function SettingsArea() {
  const { rest, navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const [query, setQuery] = useState("");
  const locationHash = useSettingsSectionHash();
  // The update badge and Ops › Health link `/settings/general#updates`; the card itself is `#application-updates`.
  const hash = locationHash === "updates" ? "application-updates" : locationHash;
  const page =
    PAGES.find((item) => item.id === rest[0]) ??
    PAGES.find((item) => item.entries.some((entry) => entry.section === rest[0])) ??
    PAGES[0]!;
  const selectedId = page.id;
  const selectedSection = selectedSettingsSection(page, rest[0], hash);
  const searched = useMemo(() => searchSettingsPages(DISCOVERABLE_PAGES, query), [query]);
  const searching = Boolean(query.trim());

  const goTo = (href: string) => {
    setQuery("");
    navigate(href);
  };
  const openSection = (entry: SettingsIndexEntry) => {
    const url = new URL(window.location.href);
    url.pathname = `/settings/${page.id}`;
    url.hash = entry.anchor;
    navigate(`${url.pathname}${url.search}${url.hash}`);
  };
  const renderControls = (section: string) => {
    switch (section) {
      case "onboarding":
        return <FirstRunArea embedded />;
      case "general":
        return <AppearanceSettings />;
      case "personalities":
        return <PersonalitySettings />;
      case "access":
        return <DeviceAccessSettings />;
      case "workspaces":
        return <WorkspaceSettings citadelId={activeCitadelId ?? ""} activeWorkspaceId={activeWorkspaceId} />;
      case "citadel-blueprint":
        return <CitadelBlueprintSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel-overview":
        return <CitadelOverviewSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel":
        return <CitadelMasonSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel-wards":
        return <CitadelWardsSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel-council":
        return <CitadelCouncilSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel-vault":
        return <CitadelVaultSettings key={activeCitadelId} citadelId={activeCitadelId ?? ""} />;
      case "citadel-capabilities":
        return (
          <CapabilityScopesSettings
            key={`citadel:${activeCitadelId}`}
            scopeKind="citadel"
            scopeId={activeCitadelId ?? ""}
          />
        );
      case "workspace-capabilities":
        return (
          <CapabilityScopesSettings
            key={`workspace:${activeWorkspaceId}`}
            scopeKind="workspace"
            scopeId={activeWorkspaceId ?? ""}
          />
        );
      case "integrations":
        return <IntegrationConnectionsSettings workspaceId={activeWorkspaceId ?? ""} />;
      case "channels":
        return <ChannelsSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />;
      case "mcp":
        return <McpServersSettings workspaceId={activeWorkspaceId ?? ""} />;
      case "addons":
        return (
          <>
            <AddonsSettings />
            <PortablePacksSettings />
          </>
        );
      case "runtime":
        return (
          <>
            <ManagedRuntimeSettings />
            <DaemonDiagnostics />
            <VoiceRuntimeSettings />
            <LlamaSetupSettings workspaceId={activeWorkspaceId ?? ""} />
          </>
        );
      case "providers":
        return <ModelsSettings />;
      case "local-ai":
        return (
          <>
            <LlamaSetupSettings workspaceId={activeWorkspaceId ?? ""} />
            <LocalAiSettings key={activeCitadelId} />
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">Expert local runtime configuration</summary>
              <ManagedRuntimeSettings />
            </details>
          </>
        );
      case "permissions":
        return <PermissionProfileSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />;
      case "hooks":
        return <HooksSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />;
      case "tools":
        return (
          <>
            <ApprovalModeControl />
            <ToolGrantSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />
            <SafetyCatalogSummary />
          </>
        );
      case "budget":
        return <BudgetModeControl />;
      case "trust-policy":
        return <TrustPolicySettings />;
      default:
        return null;
    }
  };

  if (rest[0] === "first-run")
    return (
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-fg-muted">
            Loading setup…
          </p>
        }
      >
        <FirstRunArea />
      </Suspense>
    );
  const unavailable =
    page.entries.find((entry) => entry.section === selectedSection)?.releaseStatus === "hide"
      ? "This capability is hidden from the current release. Technical display preferences do not enable it."
      : rest[0] && !PAGES.some((item) => item.id === rest[0] || item.entries.some((entry) => entry.section === rest[0]))
        ? "This link does not match a settings page. Choose a page from Settings."
        : hash &&
            !["application-updates", "approval-mode"].includes(hash) &&
            !page.entries.some((entry) => entry.anchor === hash || entry.section === hash)
          ? "This link does not match a section on this settings page. Choose a section from Settings."
          : undefined;

  return (
    <AreaTabsProvider label="Settings pages" tabs={PAGE_TABS} current={searching ? "" : selectedId} navigate={goTo}>
      <section className={`${AREA_PAGE} min-w-0`}>
        <div
          onPointerOver={(event) => preloadPageTab(event.target)}
          onPointerDown={(event) => preloadPageTab(event.target)}
          onFocus={(event) => preloadPageTab(event.target)}
        >
          <AreaHeader
            title="Settings"
            description="Find a setting, or review the controls available in this cockpit."
            actions={
              <a
                href="/settings/first-run"
                onClick={(event) => {
                  if (isModifiedClick(event)) return;
                  event.preventDefault();
                  navigate("/settings/first-run");
                }}
                className="text-sm font-medium text-accent hover:underline"
              >
                Open three-step first-run setup
              </a>
            }
          />
        </div>
        {unavailable ? (
          <EmptyState
            title="Settings destination unavailable"
            description={unavailable}
            action={<SettingsHomeLink navigate={navigate} />}
          />
        ) : (
          <>
            <label className="flex min-h-10 max-w-xl items-center gap-2 rounded-md border border-line bg-raised px-3 focus-within:border-accent">
              <Search aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="sr-only">Search settings</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                className="min-w-0 flex-1 self-stretch bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
              />
            </label>
            {searching && searched.length === 0 ? (
              <EmptyState title="No matching settings" description="Try a different name or topic." />
            ) : null}
            <section
              key={JSON.stringify([page.id, activeCitadelId, activeWorkspaceId])}
              hidden={searching}
              aria-label={page.label}
              className="min-w-0"
            >
              {/* The selected tab names this page; the heading keeps the outline (h1 › h2 › section h3) for assistive tech. */}
              <h2 className="sr-only">{page.label}</h2>
              <SettingsSectionTabs page={page} value={selectedSection} onChange={openSection}>
                {(entry) => (
                  <>
                    {renderControls(entry.section)}
                    {!entry.completeNative ? <SettingsDestinations entries={[entry]} onNavigate={goTo} /> : null}
                  </>
                )}
              </SettingsSectionTabs>
            </section>
            {searching
              ? searched.map((result) => (
                  <section
                    key={result.id}
                    aria-label={`${result.label} search results`}
                    className="min-w-0 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
                  >
                    <h2 className="text-base font-semibold text-fg">{result.label}</h2>
                    <SettingsDestinations entries={result.entries} onNavigate={goTo} />
                  </section>
                ))
              : null}
          </>
        )}
      </section>
    </AreaTabsProvider>
  );
}

function SettingsDestinations({
  entries,
  onNavigate,
}: {
  entries: SettingsIndexEntry[];
  onNavigate: (href: string) => void;
}) {
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {entries.map((entry) => (
        <li key={entry.href} className="min-w-0 rounded-md border border-line-subtle bg-sunken">
          {entry.destination === "detailed" ? (
            <a href={entry.href} className="flex min-h-20 items-start gap-3 p-3 hover:bg-canvas">
              <SettingsDestinationContent entry={entry} />
            </a>
          ) : (
            <a
              href={entry.href}
              onPointerEnter={() => preloadSettingsSection(entry.section)}
              onFocus={() => preloadSettingsSection(entry.section)}
              onPointerDown={() => preloadSettingsSection(entry.section)}
              className="flex min-h-20 items-start gap-3 p-3 hover:bg-canvas"
              onClick={(event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                onNavigate(entry.href);
                const sectionId = entry.href.split("#")[1];
                if (sectionId)
                  requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: "start" }));
              }}
            >
              <SettingsDestinationContent entry={entry} />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function SettingsHomeLink({ navigate }: { navigate: (href: string) => void }) {
  return (
    <a
      href="/settings/general"
      onClick={(event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        navigate("/settings/general");
      }}
      className="text-sm font-medium text-accent hover:underline"
    >
      Open Settings
    </a>
  );
}

function SettingsDestinationContent({ entry }: { entry: SettingsIndexEntry }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{entry.label}</span>
        {entry.releaseStatus === "experimental" ? <span className="text-xs text-fg-muted">Experimental</span> : null}
        <span className="mt-1 block text-xs text-fg-muted">{entry.description}</span>
        <span className="mt-1 block text-xs text-fg-secondary">
          {entry.destination === "detailed"
            ? `${entry.label} controls are only in the classic view. Opens the classic view`
            : entry.completeNative
              ? "Opens cockpit controls"
              : "Opens cockpit controls and management links"}
        </span>
      </span>
      {entry.href.includes("shell=classic") ? (
        <ArrowUpRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      ) : (
        <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      )}
    </>
  );
}
