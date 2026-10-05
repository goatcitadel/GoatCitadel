import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { projectSessionActivity, threadActivityLabel } from "./thread-activity";

/** The phone picker shows the selected conversation's status from the sessions list it already has. */
export function SelectedThreadActivity({ session }: { session?: ChatSessionRecord }) {
  const compact = useMediaQuery("(width < 1024px)");
  if (!compact || !session) return null;
  return (
    <p className="text-xs text-fg-muted md:hidden" aria-label="Selected conversation activity">
      {threadActivityLabel(projectSessionActivity(session))}
    </p>
  );
}
