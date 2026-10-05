import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCitadelStructureSnapshot } from "@goatcitadel/mission-control-shared/api/citadels";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { hasCitadelRecord } from "../../features/native-routes/settings/directory-lifecycle-binding";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { readCockpitHistory } from "./cockpit-history";
import { Compass } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { useCockpitScope } from "./use-cockpit-scope";

export function ScopeSwitcher({
  compact = false,
  workspaceName = "Workspace",
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  returnFocusRef,
}: {
  compact?: boolean;
  workspaceName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const trigger = useRef<HTMLButtonElement>(null);
  const installation = getGatewayApiBaseUrl(),
    history = readCockpitHistory();
  const visible = useMediaQuery("(min-width: 640px)") && !hideTrigger;
  const activeCitadel = useQuery({
    queryKey: ["system", "scope-active-citadel", installation, activeCitadelId],
    queryFn: ({ signal }) => getCitadelStructureSnapshot(activeCitadelId, { signal }),
    enabled: visible && Boolean(activeCitadelId),
    // staleTime already refreshes a stale Citadel; forcing a refetch on every mount multiplied boot requests.
    staleTime: 30_000,
  });
  const focusIdentity = JSON.stringify([installation, activeCitadelId, activeWorkspaceId, history]);
  const focusView = useRef({ identity: focusIdentity });
  if (focusView.current.identity !== focusIdentity) focusView.current = { identity: focusIdentity };
  const renderedFocusView = focusView.current;
  const requestedFocus = useRef<{ view: typeof renderedFocusView; opener: HTMLElement | null } | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [target, setTarget] = useState({ citadelId: activeCitadelId, workspaceId: activeWorkspaceId });
  useEffect(() => {
    if (open) setTarget({ citadelId: activeCitadelId, workspaceId: activeWorkspaceId });
  }, [open, activeCitadelId, activeWorkspaceId]);
  const owner = useCockpitScope(open, target, () => setOpen(false));
  // The picker closes before the central leave modal. Its detached Switch button
  // cannot restore focus when consent is cancelled or the accepted preflight fails.
  useEffect(() => {
    const requested = requestedFocus.current;
    if (!requested) return;
    if (
      open ||
      requested.view !== renderedFocusView ||
      getGatewayApiBaseUrl() !== installation ||
      readCockpitHistory() !== history
    ) {
      requestedFocus.current = null;
      return;
    }
    if (owner.isTransitionPending()) return;
    const frame = window.requestAnimationFrame(() => {
      if (requestedFocus.current !== requested) return;
      requestedFocus.current = null;
      if (
        focusView.current !== requested.view ||
        getGatewayApiBaseUrl() !== installation ||
        readCockpitHistory() !== history ||
        owner.isTransitionPending() ||
        document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')
      )
        return;
      if (requested.opener?.isConnected) requested.opener.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  });
  const record = activeCitadel.data?.record;
  const citadelName = activeCitadel.isFetching
    ? "Reading Citadel..."
    : !activeCitadel.isError &&
        activeCitadel.data?.citadelId === activeCitadelId &&
        hasCitadelRecord(record) &&
        record.citadelId === activeCitadelId &&
        record.lifecycleStatus === "active"
      ? record.name
      : "Citadel unavailable";
  return (
    <>
      {!hideTrigger ? (
        <button
          ref={trigger}
          type="button"
          aria-label="Change Citadel and workspace"
          title="Change Citadel and workspace"
          disabled={owner.busy}
          onClick={() => {
            if (owner.isTransitionPending() || document.querySelector('[role="dialog"][data-state="open"]')) return;
            setTarget({ citadelId: activeCitadelId, workspaceId: activeWorkspaceId });
            setOpen(true);
          }}
          className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-fg hover:bg-sunken"
        >
          <Compass aria-hidden="true" className="size-4 shrink-0" />
          {!compact ? (
            <span className="min-w-0 truncate">
              {citadelName} / {workspaceName}
            </span>
          ) : null}
        </button>
      ) : null}
      {owner.busy ? (
        <p role="status" className="text-xs text-fg-muted">
          Checking scope...
        </p>
      ) : null}
      {owner.error ? (
        <p role="alert" className="break-words text-xs text-status-failed">
          {owner.error}
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            focusView.current !== renderedFocusView ||
            getGatewayApiBaseUrl() !== installation ||
            readCockpitHistory() !== history ||
            owner.isTransitionPending() ||
            document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')
          )
            return;
          const opener = returnFocusRef?.current ?? trigger.current;
          if (opener?.isConnected) opener.focus();
        }}
        title="Change operating scope"
        description="Choose an active Citadel and workspace. This changes your view; it does not move work or grant access. Unsaved changes are reviewed before switching."
      >
        <div className="space-y-3">
          <label className="block text-sm text-fg-secondary">
            Citadel
            <select
              aria-label="Scope Citadel"
              value={target.citadelId}
              onChange={(event) => setTarget({ citadelId: event.target.value, workspaceId: "" })}
              className="mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
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
              aria-label="Scope Workspace"
              value={target.workspaceId}
              onChange={(event) => setTarget((current) => ({ ...current, workspaceId: event.target.value }))}
              className="mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
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
            <p role="status" className="text-sm text-fg-muted">
              Loading active scope choices...
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
            onClick={() => {
              requestedFocus.current = { view: renderedFocusView, opener: returnFocusRef?.current ?? trigger.current };
              if (!owner.select(target.citadelId, target.workspaceId)) requestedFocus.current = null;
            }}
          >
            Switch scope
          </Button>
        </div>
      </Dialog>
    </>
  );
}
