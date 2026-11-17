import { useLayoutEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export type InstallCompletionHandoff = { played: boolean };

/** The confirmation belongs to this panel's transition into done or to an unplayed handoff. */
export function useInstallConfirmation(identity: string, completed: boolean, handoff?: InstallCompletionHandoff) {
  const [seen, setSeen] = useState(() => ({ identity, completed, animate: completed && handoff?.played === false }));
  if (seen.identity !== identity || seen.completed !== completed) {
    setSeen({ identity, completed, animate: completed && seen.identity === identity });
  }
  useLayoutEffect(() => {
    // The inspector may later reopen this same body, so consume a handoff only once it has been displayed.
    if (completed && handoff) handoff.played = true;
  }, [completed, handoff]);
  return seen.animate && completed;
}

export function InstallConfirmationIcon({
  identity,
  completed,
  handedOff,
}: {
  identity: string;
  completed: boolean;
  handedOff?: InstallCompletionHandoff;
}) {
  const animate = useInstallConfirmation(identity, completed, handedOff);
  return completed ? (
    <Check
      aria-hidden="true"
      className={cn("inline size-4 text-status-done", animate && "cockpit-install-confirmed")}
    />
  ) : null;
}
