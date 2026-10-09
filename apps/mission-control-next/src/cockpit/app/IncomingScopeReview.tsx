import { useRef, useState } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../ui/Button";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { useCockpitRoute } from "./use-cockpit-route";

/** Bookmarks request a view. Only the existing reviewed directory owner can select its scope. */
export function IncomingScopeReview() {
  const { pathname, search, hash } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const parameters = new URLSearchParams(search);
  const citadelId = parameters.get("citadelId"),
    workspaceId = parameters.get("workspaceId");
  const mismatch = Boolean(
    (citadelId && citadelId !== activeCitadelId) || (workspaceId && workspaceId !== activeWorkspaceId),
  );
  if (!mismatch) return null;
  return (
    <section
      aria-label="Linked scope review"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-raised px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-sm text-fg-secondary">
        This link requests a different Citadel or workspace. The current scope stays active until you review the
        available choices.
      </p>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Review linked scope
      </Button>
      <ScopeSwitcher
        hideTrigger
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        destination={pathname + search + hash}
      />
    </section>
  );
}
