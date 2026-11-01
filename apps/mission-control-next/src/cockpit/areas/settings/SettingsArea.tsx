import { Suspense, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Search } from "lucide-react";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader, AreaTabsProvider } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { cockpitInputClass } from "../../ui/input-class";
import { projectFirstRunState } from "./first-run-state";
import { isModifiedClick } from "../../lib/modified-click";
import { buildSettingsIndex, searchSettingsPages, type SettingsIndexEntry } from "./settings-index";
import { SettingsSectionTabs, selectedSettingsSection, useSettingsSectionHash } from "./SettingsSectionTabs";
import {
  FirstRunArea,
  FirstRunStatus,
  AppearanceSettings,
  DeviceAccessSettings,
  PersonalitySettings,
  WorkspaceSettings,
  ManagedRuntimeSettings,
  BudgetModeControl,
  ApprovalModeControl,
  SettingsApprovalSkipControl,
  BrowserErrandsControl,
  FilesystemWriteRootsControl,
  ModelsSettings,
  ClaudeCliToolBridgeControl,
  ClaudeCliWarmContinuationControl,
  ChatThinkingStreamControl,
  ToolGrantSettings,
  SafetyCatalogSummary,
  PermissionProfileSettings,
  TrustPolicySettings,
  LocalAiSettings,
  CitadelBlueprintSettings,
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
  PortablePacksSettings,
  preloadSettingsSection,
} from "./settings-controls";
import { RulesPrecedenceLink } from "./RulesPrecedence";
import { ClaudeCliBackgroundJobsNotice } from "./ClaudeCliBackgroundJobsNotice";
import { LLAMA_SETUP_HREF, MANAGED_RUNTIME_HREF, SettingsOwnerPointer } from "./SettingsOwnerPointer";

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
  const queryClient = useQueryClient();
  // Get started stays in the header only until the first answer is verified (ST-N05); unknown progress keeps it.
  const onboarding = useQuery({ queryKey: ["system", "onboarding"], queryFn: fetchOnboardingState });
  const setupUnfinished = !onboarding.data || !projectFirstRunState(onboarding.data).firstResponseVerified;

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
        return <FirstRunStatus />;
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
      // MCP servers, Integrations and Web & Search are on Capabilities › Connectors › Advanced setup, and Channels on
      // Chat › Messaging › Advanced channel setup. Capability packs wait here, on Advanced, for the Plugins tab.
      case "addons":
        return <PortablePacksSettings />;
      // One owner page per editor: llama.cpp setup lives on Models › Local AI, the managed runtime on Advanced.
      case "runtime":
        return (
          <>
            <ManagedRuntimeSettings />
            <DaemonDiagnostics />
            <VoiceRuntimeSettings />
            <SettingsOwnerPointer text="llama.cpp setup is on" label="Models › Local AI" href={LLAMA_SETUP_HREF} />
          </>
        );
      case "providers":
        return (
          <>
            <ModelsSettings />
            <ChatThinkingStreamControl />
            <ClaudeCliToolBridgeControl />
            <ClaudeCliWarmContinuationControl />
            <ClaudeCliBackgroundJobsNotice />
          </>
        );
      case "local-ai":
        return (
          <>
            <LlamaSetupSettings workspaceId={activeWorkspaceId ?? ""} />
            <LocalAiSettings key={activeCitadelId} />
            <SettingsOwnerPointer
              text="The managed local runtime is on"
              label="Advanced › Runtime configuration"
              href={MANAGED_RUNTIME_HREF}
            />
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
            <SettingsApprovalSkipControl />
            <BrowserErrandsControl />
            <FilesystemWriteRootsControl />
            <ToolGrantSettings key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />
            <SafetyCatalogSummary />
          </>
        );
      case "budget":
        return <BudgetModeControl />;
      case "trust-policy":
        return (
          <>
            <RulesPrecedenceLink />
            <TrustPolicySettings />
          </>
        );
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
            ![
              "application-updates",
              "approval-mode",
              "browser-errands",
              "chat-thinking-stream",
              "claude-cli-tool-bridge",
              "claude-cli-warm-continuation",
              "filesystem-write-roots",
              "notification-routing",
              "settings-approval-skip",
            ].includes(hash) &&
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
            title={searching ? "Settings" : page.label}
            description="Find a setting, or change the ones on this page."
            actions={
              <>
                <label className="relative flex w-full min-w-0 items-center sm:w-64">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-fg-muted" />
                  <span className="sr-only">Search settings</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search settings"
                    className={`${cockpitInputClass} w-full pl-9`}
                  />
                </label>
                {setupUnfinished ? (
                  <a
                    href="/settings/first-run"
                    onClick={(event) => {
                      if (isModifiedClick(event)) return;
                      event.preventDefault();
                      navigate("/settings/first-run");
                    }}
                    className="inline-flex min-h-9 items-center rounded-md bg-accent px-3.5 text-base font-medium text-accent-ink hover:bg-accent-hover"
                  >
                    Get started
                  </a>
                ) : null}
                <Button onClick={() => void queryClient.invalidateQueries()}>
                  <RefreshCw aria-hidden="true" className="size-4" /> Refresh
                </Button>
              </>
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
          {entry.completeNative ? "Opens cockpit controls" : "Opens cockpit controls and management links"}
        </span>
      </span>
      <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
    </>
  );
}
