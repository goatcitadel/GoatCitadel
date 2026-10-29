import { Castle, FolderPlus, MessageSquarePlus } from "lucide-react";
import { NativeDisclosureCard } from "../NativeRoutePageLayout";
import { NativeButton } from "../primitives";

type ProjectsLeadStackProps = {
  onCreateProject: () => void;
  onStartChat: () => void;
  onUseSample: () => void;
  onOpenCitadels: () => void;
  onOpenMason: () => void;
};

/** The guided lead shown above an empty projects list. */
export function ProjectsLeadStack({
  onCreateProject,
  onStartChat,
  onUseSample,
  onOpenCitadels,
  onOpenMason,
}: ProjectsLeadStackProps) {
  return (
    <div className="mc-next-project-lead-stack">
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
      <NativeDisclosureCard
        id="projects-citadel-context"
        title="About Citadels"
        subtitle="How Personal and Company operating spaces govern projects."
      >
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
      </NativeDisclosureCard>
    </div>
  );
}
