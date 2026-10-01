import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Search } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { EmptyState } from "../../ui/EmptyState";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { buildSettingsIndex, searchSettingsPages, type SettingsIndexEntry } from "./settings-index";
import { SettingsSectionTabs, selectedSettingsSection, useSettingsSectionHash } from "./SettingsSectionTabs";
import { FirstRunArea } from "./FirstRunArea";
import { AppearanceSettings } from "./AppearanceSettings";
import { DeviceAccessSettings } from "./DeviceAccessSettings";
import { PersonalitySettings } from "./PersonalitySettings";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { IntegrationConnectionsSettings } from "./IntegrationConnectionsSettings";
import { ManagedRuntimeSettings } from "./ManagedRuntimeSettings";
import { McpServersSettings } from "./McpServersSettings";
import { BudgetModeControl } from "./BudgetModeControl";
import { ApprovalModeControl } from "./ApprovalModeControl";
import { ModelsSettings } from "./ModelsSettings";
import { ToolGrantSettings } from "./ToolGrantSettings";
import { SafetyCatalogSummary } from "./SafetyCatalogSummary";
import { PermissionProfileSettings } from "./PermissionProfileSettings";
import { TrustPolicySettings } from "./TrustPolicySettings";
import { LocalAiSettings } from "./LocalAiSettings";
import { CitadelBlueprintSettings } from "./CitadelBlueprintSettings";
import { ChannelsSettings } from "./ChannelsSettings";
import { CitadelOverviewSettings } from "./CitadelOverviewSettings";
import { CitadelMasonSettings } from "./CitadelMasonSettings";
import { CitadelWardsSettings } from "./CitadelWardsSettings";
import { CitadelCouncilSettings } from "./CitadelCouncilSettings";
import { CitadelVaultSettings } from "./CitadelVaultSettings";
import { DaemonDiagnostics } from "./DaemonDiagnostics";
import { VoiceRuntimeSettings } from "./VoiceRuntimeSettings";
import { LlamaSetupSettings } from "./LlamaSetupSettings";
import { CapabilityScopesSettings } from "./CapabilityScopesSettings";
import { HooksSettings } from "./HooksSettings";
import { AddonsSettings } from "./AddonsSettings";
import { PortablePacksSettings } from "./PortablePacksSettings";

const PAGES = buildSettingsIndex();

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
  const searched = useMemo(() => searchSettingsPages(PAGES, query), [query]);
  const searching = Boolean(query.trim());

  const openSection = (entry: SettingsIndexEntry) => {
    const url = new URL(window.location.href);
    url.pathname = `/settings/${page.id}`;
    url.hash = entry.anchor;
    navigate(`${url.pathname}${url.search}${url.hash}`);
  };
  const renderControls = (section: string) => {
    switch (section) {
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
        return <LocalAiSettings key={activeCitadelId} />;
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

  if (rest[0] === "first-run") return <FirstRunArea />;

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="font-display text-xl font-semibold text-fg">Settings</h1>
        <p className="text-sm text-fg-secondary">Find a setting, or review the controls available in this cockpit.</p>
        <p className="mt-1 text-xs text-fg-muted">Additional controls open in detailed settings.</p>
        <a
          href="/settings/first-run"
          onClick={(event) => {
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
        {PAGES.map((page) => (
          <a
            key={page.id}
            href={`/settings/${page.id}`}
            aria-current={!query.trim() && selectedId === page.id ? "page" : undefined}
            onClick={(event) => {
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
        key={page.id}
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
