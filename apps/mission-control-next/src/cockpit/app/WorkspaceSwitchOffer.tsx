import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../data/query-keys";
import { Button } from "../ui/Button";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { useCockpitRoute } from "./use-cockpit-route";

type WorkspaceItem = { workspaceId: string; name?: string };

/**
 * The display name of a workspace in the given Citadel (the active one by default), read from the workspace list the
 * sidebar already loads (same key). `loading` is true until that list has answered, so a name that is not there yet is
 * not mistaken for one that is not in the list.
 */
export function useWorkspaceDirectoryName(workspaceId: string, citadelId?: string) {
  const { activeCitadelId } = useUiPreferences();
  const scope = citadelId || activeCitadelId;
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(scope),
    queryFn: () => fetchWorkspaces("active", 200, scope),
  });
  const items = (workspaces.data as { items?: WorkspaceItem[] } | undefined)?.items;
  const name = Array.isArray(items) ? items.find((item) => item.workspaceId === workspaceId)?.name?.trim() : undefined;
  return { name: name || undefined, loading: workspaces.isPending };
}

/** The address of this page with the given scope set, for the switcher to pre-select. */
function destinationFor(pathname: string, search: string, hash: string, workspaceId: string, citadelId?: string) {
  const parameters = new URLSearchParams(search);
  parameters.set("workspaceId", workspaceId);
  if (citadelId) parameters.set("citadelId", citadelId);
  return `${pathname}?${parameters.toString()}${hash}`;
}

/**
 * Says a record belongs to another workspace and offers to switch to it. The switch goes through the scope switcher,
 * which reviews unsaved changes first and pre-selects the workspace asked for.
 */
export function WorkspaceSwitchOffer({
  workspaceId,
  citadelId,
  sentence,
}: {
  workspaceId: string;
  citadelId?: string;
  sentence: (name: string) => string;
}) {
  const { pathname, search, hash } = useCockpitRoute();
  const { name, loading } = useWorkspaceDirectoryName(workspaceId, citadelId);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (loading) return <p className="text-sm text-fg-secondary">Checking the workspace…</p>;
  if (!name) return <p className="text-sm text-fg-secondary">This workspace isn&apos;t in your list.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-sm text-fg-secondary">{sentence(name)}</p>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Switch to {name}
      </Button>
      <ScopeSwitcher
        hideTrigger
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        destination={destinationFor(pathname, search, hash, workspaceId, citadelId)}
      />
    </div>
  );
}
