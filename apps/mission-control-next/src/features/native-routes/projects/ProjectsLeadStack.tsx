import { Castle, FolderPlus, MessageSquarePlus } from "lucide-react";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { NativeDisclosureCard } from "../NativeRoutePageLayout";
import { NativeButton } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import type { deriveProjectHome } from "./ProjectsRoutePage.helpers";

type ProjectsLeadStackProps = {
  selectedProject: ChatProjectRecord | null;
  projectHome: ReturnType<typeof deriveProjectHome> | null;
  projectCount: number;
  theme: NativeRoutePagesProps["route"]["theme"];
  navigate: NativeRoutePagesProps["navigate"];
  onCreateProject: () => void;
  onStartChat: () => void;
  onUseSample: () => void;
  onOpenCitadels: () => void;
  onOpenMason: () => void;
};

export function ProjectsLeadStack({
  selectedProject,
  projectHome,
  projectCount,
  theme,
  navigate,
  onCreateProject,
  onStartChat,
  onUseSample,
  onOpenCitadels,
  onOpenMason,
}: ProjectsLeadStackProps) {
  // WS-D2: "Continue where you left off" lead built from the already-selected
  // project and its derived home. The Open action reuses the most-recent session
  // (via the same navigate shape the thread groups use) or falls back to
  // continuing the project's freshest surface. Suppressed when no project exists
  // so the existing guided empty state leads instead.
  const recentLeadSession = projectHome?.recentSessions[0] ?? null;
  const projectContinuationLead =
    selectedProject && projectHome ? (
      <article className="mc-next-project-lead-card" aria-label="Continue where you left off">
        <div className="mc-next-settings-selectable-head">
          <strong>{selectedProject.name}</strong>
          <span>{projectHome.healthLabel}</span>
        </div>
        <p>
          {/* "No activity yet" reads as a full phrase; only real timestamps get the "Last activity" prefix. */}
          {`${projectHome.lastActivityLabel === "No activity yet" ? "" : "Last activity "}${projectHome.lastActivityLabel} · ${
            projectHome.activeCount
          } active ${projectHome.activeCount === 1 ? "thread" : "threads"} · ${
            selectedProject.description?.trim() || selectedProject.workspacePath
          }`}
        </p>
        <div className="mc-next-settings-button-row">
          <NativeButton
            onClick={() => {
              if (recentLeadSession) {
                navigate({
                  area: recentLeadSession.mode ?? "chat",
                  sessionId: recentLeadSession.sessionId,
                  projectId: selectedProject.projectId,
                  theme,
                });
                return;
              }
              navigate({ area: "projects", projectId: selectedProject.projectId, theme });
            }}
          >
            <MessageSquarePlus size={16} />
            {recentLeadSession ? "Open latest thread" : "Open project"}
          </NativeButton>
          <NativeButton variant="outline" onClick={onOpenCitadels}>
            <Castle size={16} />
            Open Citadel
          </NativeButton>
        </div>
      </article>
    ) : null;
  const emptyProjectLead =
    projectCount === 0 ? (
      <article className="mc-next-project-empty-guide mc-next-project-empty-guide-promoted">
        <div>
          <span className="mc-next-project-lead-eyebrow">First project</span>
          <strong>Create a bounded home for the work</strong>
          <p>Start with a project, then open Chat or use the sample mission to shape its first run.</p>
        </div>
        <div className="mc-next-settings-button-row">
          <NativeButton onClick={onCreateProject}>
            <FolderPlus size={16} />
            Create project
          </NativeButton>
          <NativeButton variant="outline" onClick={onStartChat}>
            <MessageSquarePlus size={16} />
            Start Chat
          </NativeButton>
          <NativeButton variant="outline" onClick={onUseSample}>
            Use sample mission
          </NativeButton>
        </div>
      </article>
    ) : null;
  const citadelLead = (
    <article className="mc-next-project-citadel-lead" aria-label="Default Citadels">
      <div>
        <span>Citadels</span>
        <strong>Personal and Company operating spaces ship by default.</strong>
        <p>
          Use Citadels to govern projects with a Charter, Chambers, Wards, and Gatehouse posture before work crosses
          sensitive boundaries.
        </p>
      </div>
      <div className="mc-next-project-citadel-defaults" aria-label="Default Citadel types">
        <div>
          <strong>Personal</strong>
          <span>Private goals, routines, notes, and approval-gated assistance.</span>
        </div>
        <div>
          <strong>Company</strong>
          <span>Shared work, business memory, roles, and governed operating posture.</span>
        </div>
      </div>
      <div className="mc-next-settings-button-row">
        <NativeButton onClick={onOpenCitadels}>
          <Castle size={16} />
          Open Citadels
        </NativeButton>
        <NativeButton variant="outline" onClick={onOpenMason}>
          <FolderPlus size={16} />
          Use Mason
        </NativeButton>
      </div>
    </article>
  );
  return (
    <div className="mc-next-project-lead-stack">
      {projectContinuationLead}
      {emptyProjectLead}
      {projectCount === 0 ? (
        <NativeDisclosureCard
          id="projects-citadel-context"
          title="About Citadels"
          subtitle="How Personal and Company operating spaces govern projects."
        >
          {citadelLead}
        </NativeDisclosureCard>
      ) : (
        citadelLead
      )}
    </div>
  );
}
