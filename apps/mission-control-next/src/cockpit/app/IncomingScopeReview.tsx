import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCitadels } from "@goatcitadel/mission-control-shared/api/citadels";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../data/query-keys";
import { Button } from "../ui/Button";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { useCockpitRoute } from "./use-cockpit-route";
import { useWorkspaceDirectoryName } from "./WorkspaceSwitchOffer";

/** The address without the scope it asked for, so the page stays in the scope that is open. */
function withoutRequestedScope(pathname: string, search: string, hash: string) {
  const parameters = new URLSearchParams(search);
  parameters.delete("workspaceId");
  parameters.delete("citadelId");
  const rest = parameters.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

function useCitadelDirectoryName(citadelId: string, enabled: boolean) {
  const citadels = useQuery({
    queryKey: queryKeys.citadels(),
    queryFn: () => listCitadels("active", 500),
    enabled,
  });
  const items = (citadels.data as { items?: Array<{ citadelId: string; name?: string }> } | undefined)?.items;
  const name = Array.isArray(items) ? items.find((item) => item.citadelId === citadelId)?.name?.trim() : undefined;
  return { name: name || undefined, loading: enabled && citadels.isPending };
}

/** Bookmarks request a view. Only the existing reviewed directory owner can select its scope. */
export function IncomingScopeReview() {
  const { pathname, search, hash } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const parameters = new URLSearchParams(search);
  const citadelId = parameters.get("citadelId"),
    workspaceId = parameters.get("workspaceId");
  const workspaceMismatch = Boolean(workspaceId && workspaceId !== activeWorkspaceId);
  const citadelMismatch = Boolean(citadelId && citadelId !== activeCitadelId);
  // The directory is read only for a link that asks for another scope.
  if (!workspaceMismatch && !citadelMismatch) return null;
  return (
    <LinkedScopeBanner
      location={{ pathname, search, hash }}
      citadelId={citadelId}
      workspaceId={workspaceMismatch ? workspaceId : null}
    />
  );
}

function LinkedScopeBanner({
  location: { pathname, search, hash },
  citadelId,
  workspaceId,
}: {
  location: { pathname: string; search: string; hash: string };
  citadelId: string | null;
  /** The workspace the link asks for, when it is not the open one. */
  workspaceId: string | null;
}) {
  const { navigate } = useCockpitRoute();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A workspace asked for is named first; a Citadel is named only when the link asks for nothing narrower.
  const workspace = useWorkspaceDirectoryName(workspaceId ?? "", citadelId ?? undefined);
  const citadel = useCitadelDirectoryName(citadelId ?? "", !workspaceId);
  const kind = workspaceId ? "workspace" : "Citadel";
  const { name, loading } = workspaceId ? workspace : citadel;
  const sentence = loading
    ? `Checking the ${kind} this link is for…`
    : name
      ? `This link is for the ${name} ${kind}, not the one you have open.`
      : `This link is for ${kind === "workspace" ? "a workspace" : "a Citadel"} that isn't in your list.`;
  return (
    <section
      aria-label="Linked scope review"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-raised px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-sm text-fg-secondary">{sentence}</p>
      {loading ? null : (
        <Button ref={trigger} onClick={() => setOpen(true)}>
          {name ? `Switch to ${name}` : "Review linked scope"}
        </Button>
      )}
      <Button onClick={() => navigate(withoutRequestedScope(pathname, search, hash), { replace: true })}>
        Stay here
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
