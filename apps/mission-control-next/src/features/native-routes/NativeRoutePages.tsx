import { Suspense, lazy } from "react";
import { routeKicker, type AppRoute } from "@next/app/route-model";
import { NativePageFrame } from "./NativeRoutePageLayout";
import { routeSectionWithDefault } from "./shared/native-helpers";
import type { NativeRoutePagesProps } from "./types";
import "./native-routes.css";

// Load only the requested page instead of parsing every Library and Ops surface.
const CitadelBlueprintRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelBlueprintRoutePage")).CitadelBlueprintRoutePage,
}));
const CitadelCouncilRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelCouncilRoutePage")).CitadelCouncilRoutePage,
}));
const CitadelMasonRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelMasonRoutePage")).CitadelMasonRoutePage,
}));
const CitadelOverviewRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelOverviewRoutePage")).CitadelOverviewRoutePage,
}));
const CitadelVaultRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelVaultRoutePage")).CitadelVaultRoutePage,
}));
const CitadelWardsRoutePage = lazy(async () => ({
  default: (await import("./library/CitadelWardsRoutePage")).CitadelWardsRoutePage,
}));
const CuratorRoutePage = lazy(async () => ({ default: (await import("./library/CuratorRoutePage")).CuratorRoutePage }));
const MemoryRoutePage = lazy(async () => ({ default: (await import("./library/MemoryRoutePage")).MemoryRoutePage }));
const JourneyTimelineRoutePage = lazy(async () => ({
  default: (await import("./library/JourneyTimelineRoutePage")).JourneyTimelineRoutePage,
}));
const ApprovalsRoutePage = lazy(async () => ({
  default: (await import("./ops/ApprovalsRoutePage")).ApprovalsRoutePage,
}));
const BrowserSessionsRoutePage = lazy(async () => ({
  default: (await import("./ops/BrowserSessionsRoutePage")).BrowserSessionsRoutePage,
}));
const KanbanRoutePage = lazy(async () => ({ default: (await import("./ops/KanbanRoutePage")).KanbanRoutePage }));
const OpsSavedBoardsRoutePage = lazy(async () => ({
  default: (await import("./ops/OpsSavedBoardsRoutePage")).OpsSavedBoardsRoutePage,
}));
const QualityDashboardRoutePage = lazy(async () => ({
  default: (await import("./ops/QualityDashboardRoutePage")).QualityDashboardRoutePage,
}));
const RemoteWorkersRoutePage = lazy(async () => ({
  default: (await import("./ops/RemoteWorkersRoutePage")).RemoteWorkersRoutePage,
}));
const RunDetailRoutePage = lazy(async () => ({
  default: (await import("./ops/RunDetailRoutePage")).RunDetailRoutePage,
}));
const RuntimeRoutePage = lazy(async () => ({ default: (await import("./ops/RuntimeRoutePage")).RuntimeRoutePage }));
const ProjectsRoutePage = lazy(async () => ({
  default: (await import("./projects/ProjectsRoutePage")).ProjectsRoutePage,
}));
const CoworkNativePage = lazy(async () => ({ default: (await import("./cowork/CoworkNativePage")).CoworkNativePage }));
const LibraryAgentsSection = lazy(async () => ({
  default: (await import("./library/LibraryAgentsSection")).LibraryAgentsSection,
}));
const LibraryArtifactsSection = lazy(async () => ({
  default: (await import("./library/LibraryArtifactsSection")).LibraryArtifactsSection,
}));
const LibraryCapabilitiesSection = lazy(async () => ({
  default: (await import("./library/LibraryCapabilitiesSection")).LibraryCapabilitiesSection,
}));
const LibraryCommunicationsSection = lazy(async () => ({
  default: (await import("./library/LibraryCommunicationsSection")).LibraryCommunicationsSection,
}));
const LibraryFilesSection = lazy(async () => ({
  default: (await import("./library/LibraryFilesSection")).LibraryFilesSection,
}));
const LibraryKnowledgeSection = lazy(async () => ({
  default: (await import("./library/LibraryKnowledgeSection")).LibraryKnowledgeSection,
}));
const LibraryNotesSection = lazy(async () => ({
  default: (await import("./library/LibraryNotesSection")).LibraryNotesSection,
}));
const LibraryPromptPacksSection = lazy(async () => ({
  default: (await import("./library/LibraryPromptPacksSection")).LibraryPromptPacksSection,
}));
const LibrarySkillsSection = lazy(async () => ({
  default: (await import("./library/LibrarySkillsSection")).LibrarySkillsSection,
}));

const NextSettingsNativePage = lazy(async () => ({
  default: (await import("./SettingsNativePage")).SettingsNativePage,
}));

export type { CoworkTaskContinuationSummary } from "./shared/native-helpers";

export {
  dedupeAgentProfiles,
  deriveCapabilityStatus,
  deriveCoworkTaskContinuation,
  formatArtifactProvenance,
  formatBytes,
  formatDateTime,
  formatEvidenceMetadata,
  formatKnowledgeCitationAction,
  formatKnowledgeCitationSummary,
  formatPercent,
  formatTaskStatus,
  getErrorMessage,
  mergeCapabilities,
  nativeLoad,
  nativeLoadIssues,
  parseCriterionDrafts,
  parseScenarioDrafts,
  readPayloadEvidenceRefs,
  readPayloadPath,
  readPayloadString,
  routeSectionWithDefault,
  serializeCriterionDrafts,
  serializeScenarioDrafts,
  splitCommaList,
  summarizeCapabilityCounts,
  truncateText,
} from "./shared/native-helpers";

export function NativeRoutePages(props: NativeRoutePagesProps) {
  const { route } = props;

  if (route.area === "cowork") {
    return <CoworkNativePage {...props} />;
  }
  if (route.area === "library") {
    return <LibraryNativePage key={`${props.activeCitadelId}:${props.activeWorkspaceId}`} {...props} />;
  }
  if (route.area === "ops") {
    const section = route.section ?? "activity";
    if (route.view === "run-detail" || route.runId) {
      return <RunDetailRoutePage {...props} />;
    }
    if (section === "sessions" && route.view === "browser-sessions") {
      return <BrowserSessionsRoutePage {...props} />;
    }
    if (section === "approvals") {
      return <ApprovalsRoutePage {...props} />;
    }
    if (section === "boards") {
      return <OpsSavedBoardsRoutePage {...props} />;
    }
    if (section === "kanban") {
      return <KanbanRoutePage {...props} />;
    }
    if (section === "quality") {
      return <QualityDashboardRoutePage {...props} />;
    }
    if (section === "workers") {
      return <RemoteWorkersRoutePage {...props} />;
    }
    return <RuntimeRoutePage {...props} />;
  }
  if (route.area === "projects") {
    return <ProjectsRoutePage {...props} />;
  }
  return <SettingsNativePage {...props} />;
}

function LibraryNativePage(props: NativeRoutePagesProps) {
  const section = routeSectionWithDefault(props.route, "agents");
  if (
    section === "curator" ||
    section === "memory" ||
    section === "citadel" ||
    section === "citadel-overview" ||
    section === "citadel-wards" ||
    section === "citadel-council" ||
    section === "citadel-blueprint" ||
    section === "citadel-vault"
  ) {
    return renderLibrarySection(section, props);
  }

  return (
    <NativePageFrame
      area="library"
      kicker={routeKicker(props.route)}
      title={labelForLibrarySection(section)}
      description={descriptionForLibrarySection(section, props.activeWorkspaceName)}
      loading={false}
      error={null}
    >
      {renderLibrarySection(section, props)}
    </NativePageFrame>
  );
}

function renderLibrarySection(section: NonNullable<AppRoute["section"]>, props: NativeRoutePagesProps) {
  switch (section) {
    case "skills":
      return <LibrarySkillsSection {...props} />;
    case "capabilities":
      return <LibraryCapabilitiesSection {...props} />;
    case "curator":
      return <CuratorRoutePage {...props} />;
    case "citadel":
      return <CitadelMasonRoutePage {...props} />;
    case "citadel-overview":
      return <CitadelOverviewRoutePage {...props} />;
    case "citadel-wards":
      return <CitadelWardsRoutePage {...props} />;
    case "citadel-council":
      return <CitadelCouncilRoutePage {...props} />;
    case "citadel-blueprint":
      return <CitadelBlueprintRoutePage {...props} />;
    case "citadel-vault":
      return <CitadelVaultRoutePage {...props} />;
    case "memory":
      return <MemoryRoutePage {...props} />;
    case "journey":
      return <JourneyTimelineRoutePage {...props} />;
    case "knowledge":
      return <LibraryKnowledgeSection {...props} />;
    case "notes":
      return <LibraryNotesSection {...props} />;
    case "communications":
      return <LibraryCommunicationsSection {...props} />;
    case "files":
      return <LibraryFilesSection {...props} />;
    case "artifacts":
      return <LibraryArtifactsSection {...props} />;
    case "prompt-packs":
      return <LibraryPromptPacksSection {...props} />;
    default:
      return <LibraryAgentsSection {...props} />;
  }
}

function SettingsNativePage({
  route,
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  activeWorkspaceName,
  navigate,
  setActiveCitadelId,
  setActiveWorkspaceId,
}: NativeRoutePagesProps) {
  const citadelId = activeCitadelId ?? activeWorkspaceId;
  const citadelName = activeCitadelName ?? activeWorkspaceName;
  return (
    <Suspense fallback={<SettingsNativePageFallback activeWorkspaceName={activeWorkspaceName} />}>
      <NextSettingsNativePage
        route={route}
        activeCitadelId={citadelId}
        activeCitadelName={citadelName}
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        navigate={navigate}
        setActiveCitadelId={setActiveCitadelId}
        setActiveWorkspaceId={setActiveWorkspaceId}
      />
    </Suspense>
  );
}

function SettingsNativePageFallback({ activeWorkspaceName }: Pick<NativeRoutePagesProps, "activeWorkspaceName">) {
  return (
    <NativePageFrame
      area="settings"
      kicker="Settings"
      title="Settings"
      description={`Loading settings for ${activeWorkspaceName}.`}
      loading
      error={null}
    >
      <div className="mc-next-native-loading-placeholder" aria-label="Loading settings" />
    </NativePageFrame>
  );
}

function labelForLibrarySection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "skills":
      return "Skills";
    case "capabilities":
      return "Capabilities";
    case "curator":
      return "Skill Curator";
    case "memory":
      return "Memory";
    case "journey":
      return "Journey";
    case "knowledge":
      return "Knowledge";
    case "notes":
      return "Notes";
    case "communications":
      return "Communications";
    case "files":
      return "Files";
    case "artifacts":
      return "Artifacts";
    case "prompt-packs":
      return "Prompt Packs";
    default:
      return "Agents";
  }
}

function descriptionForLibrarySection(section: NonNullable<AppRoute["section"]>, workspaceName: string) {
  switch (section) {
    case "skills":
      return `Installed reusable skills for ${workspaceName}.`;
    case "capabilities":
      return `Skills, tools, providers, MCP entries, and channel capabilities for ${workspaceName}.`;
    case "curator":
      return `Ranked skill status, immunity flags, and archive proposals for ${workspaceName}.`;
    case "memory":
      return `Durable memory posture and recent memory items for ${workspaceName}.`;
    case "journey":
      return `Read-only memory, skill, approval, and provenance history for ${workspaceName}.`;
    case "knowledge":
      return `Attachable context sources and knowledge-oriented files for ${workspaceName}.`;
    case "notes":
      return `Notes, reminders, and business follow-ups for ${workspaceName}.`;
    case "communications":
      return `Inbox, agenda, contacts, and approval-gated outreach for ${workspaceName}.`;
    case "files":
      return `Workspace files available outside the active Code surface.`;
    case "artifacts":
      return `Generated outputs that should be easy to reopen from the native library.`;
    case "prompt-packs":
      return `Prompt-pack evaluation and model comparison review for ${workspaceName}.`;
    default:
      return `Reusable agent profiles and routing posture for ${workspaceName}.`;
  }
}
