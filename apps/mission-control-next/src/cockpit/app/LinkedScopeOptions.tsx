import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCitadels } from "@goatcitadel/mission-control-shared/api/citadels";
import { queryKeys } from "../data/query-keys";
import { Button } from "../ui/Button";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { nameWithKind, useWorkspaceDirectoryName } from "./WorkspaceSwitchOffer";

function useCitadelDirectoryName(citadelId: string, enabled: boolean) {
  const citadels = useQuery({
    queryKey: queryKeys.citadels(),
    queryFn: () => listCitadels("active", 500),
    enabled,
  });
  const items = (citadels.data as { items?: Array<{ citadelId: string; name?: string }> } | undefined)?.items;
  const name = Array.isArray(items) ? items.find((item) => item.citadelId === citadelId)?.name?.trim() : undefined;
  return { name: name || undefined, loading: enabled && citadels.isPending, failed: enabled && citadels.isError };
}

export function LinkedScopeOptions({
  destination,
  citadelId,
  workspaceId,
}: {
  destination: string;
  citadelId: string | null;
  /** The workspace the link asks for, when it is not the open one. */
  workspaceId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A workspace asked for is named first; a Citadel is named only when the link asks for nothing narrower.
  const workspace = useWorkspaceDirectoryName(workspaceId ?? "", citadelId ?? undefined);
  const citadel = useCitadelDirectoryName(citadelId ?? "", !workspaceId);
  const kind = workspaceId ? "workspace" : "Citadel";
  const { name, loading, failed } = workspaceId ? workspace : citadel;
  const sentence = loading
    ? `Checking the ${kind} this link is for…`
    : failed
      ? `Couldn't check the ${kind} this link is for.`
      : name
        ? `This link is for the ${nameWithKind(name, kind)}, not the one you have open.`
        : `This link is for ${kind === "workspace" ? "a workspace" : "a Citadel"} that isn't in your list.`;
  const switchable = Boolean(name) && !failed;
  return (
    <>
      <p className="min-w-0 flex-1 text-sm text-fg-secondary">{sentence}</p>
      {loading ? null : (
        <Button ref={trigger} onClick={() => setOpen(true)}>
          {switchable ? `Switch to ${name}` : "Review linked scope"}
        </Button>
      )}
      <ScopeSwitcher
        hideTrigger
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        destination={destination}
      />
    </>
  );
}
