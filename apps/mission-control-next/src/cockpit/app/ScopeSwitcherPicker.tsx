import { useEffect, useLayoutEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CHECKING_FOR_CHANGES } from "../data/record-view";
import { useCockpitScope } from "./use-cockpit-scope";

export function ScopeSwitcherPicker({
  activeCitadelId,
  activeWorkspaceId,
  destination,
  open,
  setOpen,
  description,
  onCloseAutoFocus,
  onBusyChange,
  onSelect,
}: {
  activeCitadelId: string;
  activeWorkspaceId: string;
  destination?: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  description: string;
  onCloseAutoFocus: (event: Event) => void;
  onBusyChange: (busy: boolean) => void;
  onSelect: (select: () => boolean | undefined) => void;
}) {
  const [target, setTarget] = useState({ citadelId: activeCitadelId, workspaceId: activeWorkspaceId });
  useEffect(() => {
    if (open) {
      const requested = new URL(destination ?? window.location.href, window.location.origin).searchParams;
      setTarget({
        citadelId: requested.get("citadelId") || activeCitadelId,
        workspaceId: requested.get("workspaceId") || activeWorkspaceId,
      });
    }
  }, [open, activeCitadelId, activeWorkspaceId, destination]);
  const owner = useCockpitScope(open, target, () => setOpen(false), destination);
  useLayoutEffect(() => onBusyChange(owner.busy), [onBusyChange, owner.busy]);
  return (
    <>
      {owner.error ? (
        <p role="alert" className="break-words text-xs text-status-failed">
          {owner.error}
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={onCloseAutoFocus}
        title="Change operating scope"
        description={description}
      >
        <div className="space-y-3">
          <label className="block text-sm text-fg-secondary">
            Citadel
            <select
              name="scope-citadel"
              value={target.citadelId}
              onChange={(event) => setTarget({ citadelId: event.target.value, workspaceId: "" })}
              className="mt-1 min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 text-md sm:text-sm text-fg"
            >
              <option value="">Choose Citadel</option>
              {!owner.citadels.some((item) => item.citadelId === target.citadelId) && target.citadelId ? (
                <option value={target.citadelId} disabled>
                  Current Citadel - unavailable
                </option>
              ) : null}
              {owner.citadels.map((item) => (
                <option key={item.citadelId} value={item.citadelId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-fg-secondary">
            Workspace
            <select
              name="scope-workspace"
              value={target.workspaceId}
              onChange={(event) => setTarget((current) => ({ ...current, workspaceId: event.target.value }))}
              className="mt-1 min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 text-md sm:text-sm text-fg"
            >
              <option value="">Choose workspace</option>
              {!owner.workspaces.some((item) => item.workspaceId === target.workspaceId) && target.workspaceId ? (
                <option value={target.workspaceId} disabled>
                  Current workspace - unavailable
                </option>
              ) : null}
              {owner.workspaces.map((item) => (
                <option key={item.workspaceId} value={item.workspaceId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {owner.loading ? (
            <p aria-busy="true" className="text-sm text-fg-muted">
              Loading active scope choices…
            </p>
          ) : owner.checking ? (
            <p aria-busy="true" className="text-sm text-fg-muted">
              {CHECKING_FOR_CHANGES}
            </p>
          ) : null}
          {owner.directoryError ? (
            <p role="alert" className="text-sm text-status-failed">
              {owner.directoryError}
            </p>
          ) : null}
          {owner.citadels.length === 500 || owner.workspaces.length === 500 ? (
            <p className="text-xs text-fg-muted">Showing up to 500 active records from each directory.</p>
          ) : null}
          <Button
            disabled={
              !owner.ready ||
              !target.workspaceId ||
              !owner.citadels.some((item) => item.citadelId === target.citadelId) ||
              !owner.workspaces.some((item) => item.workspaceId === target.workspaceId) ||
              (target.citadelId === activeCitadelId && target.workspaceId === activeWorkspaceId)
            }
            onClick={() => onSelect(() => owner.select(target.citadelId, target.workspaceId))}
          >
            Switch scope
          </Button>
        </div>
      </Dialog>
    </>
  );
}
