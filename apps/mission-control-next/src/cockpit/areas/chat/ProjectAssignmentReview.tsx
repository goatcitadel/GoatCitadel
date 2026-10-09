import { useProjectSwitchReview } from "../../../features/threaded-surface/useProjectSwitchReview";
import { useChatSelectionReview } from "./use-chat-owner-navigation";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Callout } from "../../ui/Callout";

/** Projects opens the actual conversation; the existing palette/controller remains the assignment owner. */
export function ProjectAssignmentReview({ active }: { active: Parameters<typeof useProjectSwitchReview>[0] }) {
  const route = useCockpitRoute();
  const projectId = new URLSearchParams(route.search).get("assignProjectId");
  const sessionId = new URLSearchParams(route.search).get("sessionId");
  const owner = useProjectSwitchReview(active);
  const transition = useChatSelectionReview(owner.identity);
  const destination = active.projectSwitchContext?.projects.find((project) => project.projectId === projectId);
  if (!projectId || active.selectedSessionId !== sessionId) return null;
  if (active.projectSwitchContext?.session.projectId === projectId)
    return (
      <p role="status" className="border-b border-line p-3 text-sm">
        Conversation assigned to {destination?.name ?? "the requested project"}.
      </p>
    );
  return (
    <div className="grid gap-2 border-b border-line p-3">
      <p className="text-sm">
        {destination
          ? `Assign this conversation to ${destination.name}. Review future context before switching.`
          : "The requested project is unavailable in this conversation's current scope."}
      </p>
      {owner.notice ? <Callout tone="warning">{owner.notice}</Callout> : null}
      <Button
        disabled={!destination}
        onClick={() => {
          if (destination)
            owner.begin({
              key: `project:${destination.projectId}`,
              command: destination.name,
              description: "Switch project",
              applyValue: "",
              action: { type: "switch_project", projectId: destination.projectId, projectName: destination.name },
            });
        }}
      >
        Review project assignment
      </Button>
      <Dialog
        open={owner.candidate !== null}
        onOpenChange={(open) => {
          if (!open) owner.cancel();
        }}
        title="Switch this Chat to another project?"
        description={owner.candidate?.message}
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={owner.cancel}>Cancel</Button>
          <Button onClick={() => owner.confirm(transition)}>Switch project</Button>
        </div>
      </Dialog>
    </div>
  );
}
