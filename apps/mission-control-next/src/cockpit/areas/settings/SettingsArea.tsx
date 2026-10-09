import { Suspense, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Search } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { EmptyState } from "../../ui/EmptyState";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
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

export function SettingsArea() {
  const { rest, navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const [query, setQuery] = useState("");
  const hash = useSettingsSectionHash();
  const page =
    PAGES.find((item) => item.id === rest[0]) ??
    PAGES.find((item) => item.entries.some((entry) => entry.section === rest[0])) ??
    PAGES[0]!;
  const selectedId = page.id;
  const selectedSection = selectedSettingsSection(page, rest[0], hash);
  const searched = useMemo(() => searchSettingsPages(DISCOVERABLE_PAGES, query), [query]);
  const searching = Boolean(query.trim());

  const openSection = (entry: SettingsIndexEntry) => {
    const url = new URL(window.location.href);
    url.pathname = `/settings/${page.id}`;
    url.hash = entry.anchor;
    navigate(`${url.pathname}${url.search}${url.hash}`);
  };
  const renderControls = (section: string) => {
    switch (section) {
      case "onboarding":
        return <FirstRunArea />;
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
        return <CapabilityScopesSettings key={`citadel:${activeCitadelId}`} scopeKind="citadel" scopeId={activeCitadelId ?? ""} />;
      case "workspace-capabilities":
        return <CapabilityScopesSettings key={`workspace:${activeWorkspaceId}`} scopeKind="workspace" scopeId={activeWorkspaceId ?? ""} />;
      case "integrations":
        return <IntegrationConnectionsSettings workspaceId={activeWorkspaceId ?? ""} />;
      case "channels":
        return <ChannelsSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />;
      case "mcp":
        return <McpServersSettings workspaceId={activeWorkspaceId ?? ""} />;
      case "addons":
        return <><AddonsSettings /><PortablePacksSettings /></>;
      case "runtime":
        return <><ManagedRuntimeSettings /><DaemonDiagnostics /><VoiceRuntimeSettings /><LlamaSetupSettings workspaceId={activeWorkspaceId ?? ""} /></>;
      case "providers":
        return <ModelsSettings />;
      case "local-ai":
        return <><LlamaSetupSettings workspaceId={activeWorkspaceId ?? ""} /><LocalAiSettings key={activeCitadelId} /><details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Expert local runtime configuration</summary><ManagedRuntimeSettings /></details></>;
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

  if (rest[0] === "first-run") return <Suspense fallback={<p role="status" className="p-4 text-sm text-fg-muted">Loading setup…</p>}><FirstRunArea /></Suspense>;
  if (page.entries.find((entry) => entry.section === selectedSection)?.releaseStatus === "hide") return <EmptyState title="Settings destination unavailable" description="This capability is hidden from the current release. Technical display preferences do not enable it." />;
  if (rest[0] && !PAGES.some((item) => item.id === rest[0] || item.entries.some((entry) => entry.section === rest[0]))) return <EmptyState title="Settings destination unavailable" description="This link does not identify a supported settings destination. Open Settings to choose a current page." />;
  if (hash && !["application-updates", "approval-mode"].includes(hash) && !page.entries.some((entry) => entry.anchor === hash || entry.section === hash)) return <EmptyState title="Settings destination unavailable" description="This link does not identify a supported section on this settings page. Open Settings to choose a current section." />;

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="font-display text-xl font-semibold text-fg">Settings</h1>
        <p className="text-sm text-fg-secondary">Find a setting, or review the controls available in this cockpit.</p>
        <p className="mt-1 text-xs text-fg-muted">Additional controls open in detailed settings.</p>
        <a
          href="/settings/first-run"
          onClick={(event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            navigate("/settings/first-run");
          }}
          className="mt-3 inline-flex text-sm font-medium text-accent hover:underline"
        >
          Open three-step first-run setup
        </a>
      </header>
      <label className="flex max-w-xl items-center gap-2 rounded-md border border-line bg-raised px-3 focus-within:border-accent">
        <Search aria-hidden="true" className="size-4 text-fg-muted" />
        <span className="sr-only">Search settings</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search settings"
          className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
        />
      </label>
      <nav
        aria-label="Settings pages"
        className="flex flex-wrap gap-1 border-b border-line-subtle sm:flex-nowrap sm:overflow-x-auto"
      >
        {DISCOVERABLE_PAGES.map((page) => (
          <a
            key={page.id}
            href={`/settings/${page.id}`}
            onPointerEnter={() => preloadSettingsSection(selectedSettingsSection(page, page.id, ""))}
            onFocus={() => preloadSettingsSection(selectedSettingsSection(page, page.id, ""))}
            onPointerDown={() => preloadSettingsSection(selectedSettingsSection(page, page.id, ""))}
            aria-current={!query.trim() && selectedId === page.id ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
              event.preventDefault();
              setQuery("");
              navigate(`/settings/${page.id}`);
            }}
            className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
          >
            {page.label}
          </a>
        ))}
      </nav>
      {searching && searched.length === 0 ? (
        <EmptyState title="No matching settings" description="Try a different name or topic." />
      ) : null}
      <section
        key={JSON.stringify([page.id, activeCitadelId, activeWorkspaceId])}
        hidden={searching}
        aria-label={page.label}
        className="min-w-0 rounded-lg border border-line bg-raised p-4"
      >
        <h2 className="font-display text-lg font-semibold text-fg">{page.label}</h2>
        <SettingsSectionTabs page={page} value={selectedSection} onChange={openSection}>
          {(entry) => (
            <>
              {renderControls(entry.section)}
              {!entry.completeNative ? (
                <SettingsDestinations
                  entries={[entry]}
                  onNavigate={(href) => {
                    setQuery("");
                    navigate(href);
                  }}
                />
              ) : null}
            </>
          )}
        </SettingsSectionTabs>
      </section>
      {searching
        ? searched.map((result) => (
            <section
              key={result.id}
              aria-label={`${result.label} search results`}
              className="min-w-0 rounded-lg border border-line bg-raised p-4"
            >
              <h2 className="font-display text-lg font-semibold text-fg">{result.label}</h2>
              <SettingsDestinations
                entries={result.entries}
                onNavigate={(href) => {
                  setQuery("");
                  navigate(href);
                }}
              />
            </section>
          ))
        : null}
    </section>
  );
}

function SettingsDestinations({
  entries,
  onNavigate,
}: {
  entries: SettingsIndexEntry[];
  onNavigate: (href: string) => void;
}) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const scope = JSON.stringify([activeCitadelId, activeWorkspaceId]);
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {entries.map((entry) => (
        <li key={entry.href} className="min-w-0 rounded-md border border-line-subtle bg-sunken">
          {entry.href.includes("shell=classic") ? <ClassicOwnerLink href={entry.href} scope={scope} label={entry.label}
            className="flex min-h-20 items-start gap-3 p-3 hover:bg-canvas"><SettingsDestinationContent entry={entry} /></ClassicOwnerLink> : <a
            href={entry.href}
            onPointerEnter={() => preloadSettingsSection(entry.section)}
            onFocus={() => preloadSettingsSection(entry.section)}
            onPointerDown={() => preloadSettingsSection(entry.section)}
            className="flex min-h-20 items-start gap-3 p-3 hover:bg-canvas"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
              )
                return;
              event.preventDefault();
              onNavigate(entry.href);
              const sectionId = entry.href.split("#")[1];
              if (sectionId)
                requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: "start" }));
            }}
          >
            <SettingsDestinationContent entry={entry} />
          </a>}
        </li>
      ))}
    </ul>
  );
}

function SettingsDestinationContent({ entry }: { entry: SettingsIndexEntry }) {
  return <>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{entry.label}</span>
              {entry.releaseStatus === "experimental" ? <span className="text-xs text-fg-muted">Experimental</span> : null}
              <span className="mt-1 block text-xs text-fg-muted">{entry.description}</span>
              <span className="mt-1 block text-xs text-fg-secondary">
                {entry.destination === "detailed"
                  ? "Opens detailed settings"
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
  </>;
}
