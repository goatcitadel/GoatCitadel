import { hasUnsettledChatContextMutation } from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { observeDeferredOverlayFocus } from "./deferred-overlay-focus-observer";
import { locationRevision, subscribeLocation, readLocationRevision } from "./deferred-overlay-location";
import {
  createDeferredOverlayOwner,
  type OpenKind,
  type DeferredOverlayInput,
  type DeferredOverlayIntent,
  type DeferredOverlayReloadReview,
} from "./deferred-overlay-identity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { readCockpitHistory, subscribeCockpitHistory } from "../app/cockpit-history";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

// Location events have a monotonic revision: A → B → A cannot revive an old opening.

export function useDeferredOverlay<T>({
  scopeKey,
  load,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: DeferredOverlayInput<T>) {
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const location = useSyncExternalStore(subscribeLocation, readLocationRevision, readLocationRevision);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const gateway = getGatewayApiBaseUrl();
  const { activeCitadelId: citadel, activeWorkspaceId: workspace } = useUiPreferences();
  const owner = useMemo(
    () => createDeferredOverlayOwner(gateway, caller, access, location, citadel, workspace, scopeKey),
    [gateway, caller, access, location, citadel, workspace, scopeKey],
  );
  const committedOwner = useRef(owner),
    mounted = useRef(false);
  const trigger = useRef<HTMLElement | null>(null),
    content = useRef<HTMLElement | null>(null),
    status = useRef<HTMLSpanElement | null>(null);
  const [runtime, setRuntime] = useState<T | null>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const desired = controlledOpen ?? internalOpen;
  const desiredRef = useRef(desired);
  const [intentVersion, setIntentVersion] = useState(0);
  const [failure, setFailure] = useState(false);
  type Intent = DeferredOverlayIntent<T, typeof owner>;
  const intent = useRef<Intent | null>(null);
  type ReloadReview = DeferredOverlayReloadReview<T, typeof owner>;
  const [reloadReview, setReloadReview] = useState<ReloadReview>();
  const reloadConsent = useRef<ReloadReview | undefined>(undefined),
    reloadReturnFocus = useRef<ReloadReview | undefined>(undefined);
  const recoveryHost = useRef<HTMLElement | null>(null);
  const isCurrent = useCallback(
    (candidate = owner) =>
      mounted.current &&
      committedOwner.current === candidate &&
      candidate === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayAccessRevision() === access &&
      locationRevision === location,
    [owner, gateway, caller, access, location],
  );
  const reloadCurrent = useCallback(
    (saved: ReloadReview) =>
      isCurrent(saved.ticket.owner) &&
      intent.current === saved.ticket &&
      !saved.ticket.cancelled &&
      desiredRef.current &&
      failure &&
      readCockpitHistory() === saved.history &&
      window.location.href === saved.url,
    [isCurrent, failure],
  );
  const recoveryActive = useCallback(
    () => Boolean(reloadConsent.current && reloadCurrent(reloadConsent.current)),
    [reloadCurrent],
  );
  const ownsTarget = useCallback(
    (target: Node | null) =>
      Boolean(
        target &&
        (trigger.current?.contains(target) ||
          status.current?.contains(target) ||
          content.current?.contains(target) ||
          (recoveryActive() && recoveryHost.current?.contains(target))),
      ),
    [recoveryActive],
  );
  useLayoutEffect(() => {
    reloadConsent.current = undefined;
    reloadReturnFocus.current = undefined;
    recoveryHost.current = null;
    setReloadReview(undefined);
  }, [owner, history]);
  useLayoutEffect(() => {
    mounted.current = true;
    // StrictMode replays initial effects. Old asynchronous completions retain their old ticket.
    if (intent.current?.unmounted) intent.current = null;
    return () => {
      mounted.current = false;
      reloadConsent.current = undefined;
      reloadReturnFocus.current = undefined;
      recoveryHost.current = null;
      if (intent.current) {
        intent.current.cancelled = true;
        intent.current.unmounted = true;
      }
    };
  }, []);
  useLayoutEffect(() => {
    desiredRef.current = desired;
  }, [desired]);
  const ownsFocus = useCallback(
    (ticket: Intent) => {
      const active = document.activeElement;
      return (
        active === ticket.trigger ||
        active === ticket.origin ||
        ownsTarget(active) ||
        (active === document.body && ticket.lastFocused !== null && !ticket.lastFocused.isConnected)
      );
    },
    [ownsTarget],
  );
  const commit = useCallback(
    (ticket: Intent) => {
      if (
        !isCurrent(ticket.owner) ||
        intent.current !== ticket ||
        ticket.cancelled ||
        ticket.pointerInFlight ||
        !ticket.runtime ||
        !desiredRef.current ||
        !ownsFocus(ticket)
      )
        return;
      setRuntime(() => ticket.runtime!);
    },
    [isCurrent, ownsFocus],
  );
  const close = useCallback(
    (restore = false, notify = true, revoke = false) => {
      const ticket = intent.current;
      if (ticket?.cancelled) return;
      const wasOpen = desiredRef.current;
      // A controlled ordinary close is a request. Preserve pending code/failure and
      // custody if the parent keeps true; actual departure revokes separately.
      if (!revoke && controlledOpen === true) {
        if (ticket) ticket.restore = ticket.restore && restore && isCurrent(ticket.owner) && ownsFocus(ticket);
        if (notify && wasOpen) onOpenChange?.(false);
        return;
      }
      if (ticket) {
        ticket.restore = ticket.restore && restore && isCurrent(ticket.owner) && ownsFocus(ticket);
        if (!runtime || controlledOpen !== true) ticket.cancelled = true;
      }
      reloadConsent.current = undefined;
      reloadReturnFocus.current = undefined;
      recoveryHost.current = null;
      setReloadReview(undefined);
      if (controlledOpen === undefined) {
        desiredRef.current = false;
        setInternalOpen(false);
      }
      setIntentVersion((value) => value + 1);
      setFailure(false);
      if (notify && wasOpen) onOpenChange?.(false);
      if (!runtime && ticket?.restore && ticket.trigger?.isConnected) ticket.trigger.focus({ preventScroll: true });
    },
    [controlledOpen, onOpenChange, runtime, isCurrent, ownsFocus],
  );
  const cancel = useCallback((restore = false) => close(restore, true, true), [close]);
  const begin = useCallback(
    (kind: OpenKind, pointerInFlight = false) => {
      if (!isCurrent()) return;
      const ticket: Intent = {
        owner,
        kind,
        trigger: trigger.current,
        origin: document.activeElement,
        pointerInFlight,
        cancelled: false,
        restore: true,
        lastFocused: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        unmounted: false,
      };
      reloadConsent.current = undefined;
      reloadReturnFocus.current = undefined;
      recoveryHost.current = null;
      setReloadReview(undefined);
      intent.current = ticket;
      setFailure(false);
      setIntentVersion((value) => value + 1);
      if (runtime) {
        ticket.runtime = runtime;
        return;
      }
      void load().then(
        (module) => {
          if (!isCurrent(ticket.owner) || intent.current !== ticket || ticket.cancelled) return;
          ticket.runtime = module;
          commit(ticket);
        },
        () => {
          if (isCurrent(ticket.owner) && intent.current === ticket && !ticket.cancelled) setFailure(true);
        },
      );
    },
    [isCurrent, owner, runtime, load, commit],
  );
  const request = useCallback(
    (next: boolean, kind: OpenKind = "programmatic", pointerInFlight = false) => {
      if (!isCurrent()) return;
      if (!next) {
        close(true);
        return;
      }
      if (controlledOpen === undefined) {
        desiredRef.current = true;
        setInternalOpen(true);
      }
      if (!desiredRef.current || !intent.current || intent.current.cancelled) onOpenChange?.(true);
      begin(kind, pointerInFlight);
    },
    [isCurrent, close, controlledOpen, onOpenChange, begin],
  );
  useLayoutEffect(() => {
    if (committedOwner.current === owner) return;
    const old = intent.current;
    committedOwner.current = owner;
    if (old && !old.cancelled) {
      old.cancelled = true;
      old.restore = false;
      if (desiredRef.current) onOpenChange?.(false);
    }
    if (controlledOpen === undefined) {
      desiredRef.current = false;
      setInternalOpen(false);
    }
    setFailure(false);
    setIntentVersion((value) => value + 1);
  }, [owner, controlledOpen, onOpenChange]);
  const previousControlled = useRef(controlledOpen);
  useLayoutEffect(() => {
    const changed = previousControlled.current !== controlledOpen;
    previousControlled.current = controlledOpen;
    if (
      changed &&
      controlledOpen === true &&
      (!intent.current || intent.current.cancelled || intent.current.owner !== owner)
    )
      begin("programmatic");
  }, [controlledOpen, owner, begin]);
  const previousAcceptedDesired = useRef(desired);
  useEffect(() => {
    const previouslyAccepted = previousAcceptedDesired.current;
    previousAcceptedDesired.current = desired;
    if (!desired) {
      const ticket = intent.current;
      // A refused false prop must not cancel an unaccepted opening; an accepted close
      // preserves the READY SDK close-autofocus intent and still rejects outside/stale focus.
      if (previouslyAccepted && ticket && !ticket.cancelled) close(runtime ? ticket.restore : false, false);
      return;
    }
    // Controlled/default open is itself an accepted request; a departed true prop does not revive it.
    if (!intent.current) begin("programmatic");
    else if (intent.current.owner === owner && !intent.current.cancelled) commit(intent.current);
  }, [desired, owner, runtime, begin, commit, close]);
  useEffect(() => {
    const ticket = intent.current;
    if (!ticket || ticket.cancelled) return;
    return observeDeferredOverlayFocus(ticket, {
      runtime,
      ownsTarget,
      commit,
      cancel,
      isCurrent,
      intent,
      ownsFocus,
      recoveryActive,
      close,
    });
  }, [intentVersion, runtime, close, cancel, isCurrent, ownsFocus, ownsTarget, recoveryActive, commit]);
  const finishPointer = useCallback(() => {
    const ticket = intent.current;
    if (!ticket || ticket.cancelled || !isCurrent(ticket.owner)) return;
    ticket.pointerInFlight = false;
    commit(ticket);
  }, [commit, isCurrent]);
  const requestReload = useCallback(
    (button: HTMLButtonElement) => {
      const ticket = intent.current;
      if (
        !ticket ||
        ticket.cancelled ||
        !failure ||
        !desiredRef.current ||
        !isCurrent(ticket.owner) ||
        !ownsFocus(ticket) ||
        reloadConsent.current
      )
        return;
      const saved = { ticket, button, history: readCockpitHistory(), url: window.location.href };
      reloadConsent.current = saved;
      reloadReturnFocus.current = saved;
      setReloadReview(saved);
    },
    [failure, isCurrent, ownsFocus],
  );
  const cancelReload = useCallback((saved: ReloadReview | undefined) => {
    if (!saved || reloadConsent.current !== saved) return;
    reloadConsent.current = undefined;
    setReloadReview((value) => (value === saved ? undefined : value));
  }, []);
  const confirmReload = useCallback(
    (saved: ReloadReview | undefined) => {
      if (hasUnsettledChatContextMutation() || !saved || reloadConsent.current !== saved || !reloadCurrent(saved))
        return;
      reloadConsent.current = undefined;
      reloadReturnFocus.current = undefined;
      setReloadReview((value) => (value === saved ? undefined : value));
      window.location.reload();
    },
    [reloadCurrent],
  );
  const registerRecoveryHost = useCallback((element: HTMLDivElement | null) => {
    recoveryHost.current = element?.closest<HTMLElement>('[role="dialog"]') ?? null;
  }, []);
  const restoreReloadFocus = useCallback(() => {
    const saved = reloadReturnFocus.current;
    reloadReturnFocus.current = undefined;
    if (
      saved &&
      reloadCurrent(saved) &&
      saved.button.isConnected &&
      (document.activeElement === document.body || document.activeElement === saved.button)
    )
      saved.button.focus({ preventScroll: true });
  }, [reloadCurrent]);
  const ticket = intent.current;
  const effectiveOpen =
    desired && Boolean(ticket && ticket.owner === owner && !ticket.cancelled && isCurrent(ticket.owner));
  return {
    runtime,
    open: effectiveOpen,
    loading: effectiveOpen && !runtime && !failure,
    failure: effectiveOpen && failure,
    trigger,
    content,
    status,
    request,
    close,
    cancel,
    finishPointer,
    isCurrent,
    ownsFocus,
    intent,
    owner,
    reloadReview,
    reloadCurrent,
    requestReload,
    cancelReload,
    confirmReload,
    registerRecoveryHost,
    restoreReloadFocus,
  };
}
