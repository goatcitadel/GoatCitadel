import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { StatusBadge } from "../../ui/StatusBadge";
import { projectChatStatus } from "./chat-status";

type ActiveSession = MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"];

/**
 * The open conversation's status as a pill beside its title, at every width, so whether Chat is working, waiting on
 * you, or finished is readable at a glance. Not a live region: the transcript owns streaming announcements.
 */
export function SelectedThreadActivity({ session, active }: { session?: ChatSessionRecord; active?: ActiveSession }) {
  if (!session && !active) return null;
  const status = projectChatStatus(active, session);
  return (
    <p role="note" aria-label="Selected conversation activity" className="flex shrink-0">
      <StatusBadge
        status={status}
        className="whitespace-nowrap px-2.5 py-1 text-sm max-sm:px-2 max-sm:py-0.5 max-sm:text-xs"
      />
    </p>
  );
}
