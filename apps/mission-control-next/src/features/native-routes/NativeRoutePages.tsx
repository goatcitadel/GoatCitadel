import { Suspense, lazy } from "react";
import { routeKicker, type AppRoute } from "@next/app/route-model";
import { NativePageFrame } from "./NativeRoutePageLayout";
import { CitadelBlueprintRoutePage } from "./library/CitadelBlueprintRoutePage";
import { CitadelCouncilRoutePage } from "./library/CitadelCouncilRoutePage";
import { CitadelMasonRoutePage } from "./library/CitadelMasonRoutePage";
import { CitadelOverviewRoutePage } from "./library/CitadelOverviewRoutePage";
import { CitadelVaultRoutePage } from "./library/CitadelVaultRoutePage";
import { CitadelWardsRoutePage } from "./library/CitadelWardsRoutePage";
import { CuratorRoutePage } from "./library/CuratorRoutePage";
import { MemoryRoutePage } from "./library/MemoryRoutePage";
import { ApprovalsRoutePage } from "./ops/ApprovalsRoutePage";
import { BrowserSessionsRoutePage } from "./ops/BrowserSessionsRoutePage";
import { KanbanRoutePage } from "./ops/KanbanRoutePage";
import { QualityDashboardRoutePage } from "./ops/QualityDashboardRoutePage";
import { RunDetailRoutePage } from "./ops/RunDetailRoutePage";
import { RuntimeRoutePage } from "./ops/RuntimeRoutePage";
import { ProjectsRoutePage } from "./projects/ProjectsRoutePage";
import { CoworkNativePage } from "./cowork/CoworkNativePage";
import { LibraryAgentsSection } from "./library/LibraryAgentsSection";
import { LibraryArtifactsSection } from "./library/LibraryArtifactsSection";
import { LibraryCapabilitiesSection } from "./library/LibraryCapabilitiesSection";
import { LibraryCommunicationsSection } from "./library/LibraryCommunicationsSection";
import { LibraryFilesSection } from "./library/LibraryFilesSection";
import { LibraryKnowledgeSection } from "./library/LibraryKnowledgeSection";
import { LibraryNotesSection } from "./library/LibraryNotesSection";
import { LibraryPromptPacksSection } from "./library/LibraryPromptPacksSection";
import { LibrarySkillsSection } from "./library/LibrarySkillsSection";
import { routeSectionWithDefault } from "./shared/native-helpers";
import type { NativeRoutePagesProps } from "./types";
import "./native-routes.css";

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
    return <LibraryNativePage {...props} />;
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
    if (section === "kanban") {
      return <KanbanRoutePage {...props} />;
    }
    if (section === "quality") {
      return <QualityDashboardRoutePage {...props} />;
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
