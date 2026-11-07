import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useCitadelName } from "../data/use-citadel-name";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { readCockpitHistory } from "./cockpit-history";
import { Compass } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import { useAccessBoundReview } from "@goatcitadel/mission-control-shared/hooks/use-access-bound-review";
import { useCockpitNavigation } from "./cockpit-navigation-context";

const pickerRuntime = createDeferredDialogRuntime(() =>
  import("./ScopeSwitcherPicker").then(({ ScopeSwitcherPicker }) => ScopeSwitcherPicker),
);
const pickerDescription =
  "Choose an active Citadel and workspace. This changes your view; it does not move work or grant access. Unsaved changes are reviewed before switching.";

export function ScopeSwitcher({
  destination,
  compact = false,
  workspaceName = "Workspace",
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  returnFocusRef,
}: {
  destination?: string;
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
  const visible = useMediaQuery(RESPONSIVE_QUERIES.abovePhone) && !hideTrigger;
  const citadelName = useCitadelName(activeCitadelId, visible);
  const focusIdentity = JSON.stringify([installation, activeCitadelId, activeWorkspaceId, history]);
  const focusView = useRef({ identity: focusIdentity });
  if (focusView.current.identity !== focusIdentity) focusView.current = { identity: focusIdentity };
  const renderedFocusView = focusView.current;
  const requestedFocus = useRef<{ view: typeof renderedFocusView; opener: HTMLElement | null } | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const requestedOpen = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const { isTransitionPending } = useCockpitNavigation();
  const accessCurrent = useAccessBoundReview(requestedOpen, () => setOpen(false));
  const open = requestedOpen && accessCurrent;
  const { runtime: Picker, failed } = useDeferredDialogRuntime(open, pickerRuntime);
  // The owner closes its picker before requesting the reviewed navigation, which can still be pending.
  const activated = useRef(false);
  if (open) activated.current = true;
  const handoff = useRef(false);
  handoff.current = open && Boolean(Picker);
  const [busy, setBusy] = useState(false);
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (
      focusView.current !== renderedFocusView ||
      getGatewayApiBaseUrl() !== installation ||
      readCockpitHistory() !== history ||
      isTransitionPending() ||
      document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')
    )
      return;
    const opener = returnFocusRef?.current ?? trigger.current;
    if (opener?.isConnected) opener.focus();
  };

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
    if (isTransitionPending()) return;
    const frame = window.requestAnimationFrame(() => {
      if (requestedFocus.current !== requested) return;
      requestedFocus.current = null;
      if (
        focusView.current !== requested.view ||
        getGatewayApiBaseUrl() !== installation ||
        readCockpitHistory() !== history ||
        isTransitionPending() ||
        document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')
      )
        return;
      if (requested.opener?.isConnected) requested.opener.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  });
  // NV-03: the last known Citadel name stays during a refetch; "Reading" only before the first answer.
  // SH-27: the name truncates in the rail, so the tooltip carries it in full; the collapsed rail is too narrow for
  // the busy sentence, which it keeps for assistive technology and the tooltip instead.
  const scopeName = `${citadelName} / ${workspaceName}`;
  const busyText = "Checking scope…";
  return (
    <>
      {!hideTrigger ? (
        <button
          ref={trigger}
          type="button"
          // WCAG 2.5.3: the name starts with the visible scope name, then says what the button does.
          aria-label={`${scopeName}, change Citadel and workspace`}
          title={busy ? `${scopeName}. ${busyText}` : `Change Citadel and workspace: ${scopeName}`}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => {
            if (isTransitionPending() || document.querySelector('[role="dialog"][data-state="open"]')) return;
            setOpen(true);
          }}
          className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-fg hover:bg-sunken"
        >
          <Compass aria-hidden="true" className="size-4 shrink-0" />
          {!compact ? <span className="min-w-0 truncate">{scopeName}</span> : null}
        </button>
      ) : null}
      {busy ? (
        <p role="status" className={compact ? "sr-only" : "px-2 text-xs text-fg-muted"}>
          {busyText}
        </p>
      ) : null}
      {Picker && activated.current ? (
        <Picker
          activeCitadelId={activeCitadelId}
          activeWorkspaceId={activeWorkspaceId}
          destination={destination}
          open={open}
          setOpen={setOpen}
          description={pickerDescription}
          onCloseAutoFocus={onCloseAutoFocus}
          onBusyChange={setBusy}
          onSelect={(select) => {
            requestedFocus.current = { view: renderedFocusView, opener: returnFocusRef?.current ?? trigger.current };
            if (!select()) requestedFocus.current = null;
          }}
        />
      ) : open ? (
        <PendingDialog
          title="Change operating scope"
          description={pickerDescription}
          closeLabel="Close dialog"
          className="cockpit-dialog fixed inset-x-4 top-4 m-0 mx-auto w-[calc(100%-2rem)] max-w-xl rounded-lg border border-line bg-overlay p-4 text-fg shadow-overlay backdrop:bg-scrim sm:top-24"
          onDismiss={() => setOpen(false)}
          onCloseAutoFocus={onCloseAutoFocus}
          handoff={handoff}
        >
          {failed ? (
            <p role="alert">
              Scope controls could not load. Close the picker to keep using the app, or reload the app.
            </p>
          ) : (
            <p role="status">Loading scope controls…</p>
          )}
        </PendingDialog>
      ) : null}
    </>
  );
}
