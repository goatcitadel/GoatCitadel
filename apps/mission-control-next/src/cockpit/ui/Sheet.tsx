import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import type { SheetOwner, ReloadReview } from "./sheet-owner-types";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { registerCockpitSheetBack } from "../app/cockpit-back-guard";
import { X } from "lucide-react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { IconButton } from "./IconButton";

import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { readCockpitHistory, subscribeCockpitHistory } from "../app/cockpit-history";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

import { loadDrawer, readLoadedDrawer, type DrawerModule, type DrawerContent } from "./sheet-drawer-code";

type PendingFocus = { owner: SheetOwner; node: HTMLElement; kind?: "close" | "panel" };

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  sideOnDesktop = false,
  onCloseAutoFocus,
  closeLabel = "Close sheet",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  sideOnDesktop?: boolean;
  closeLabel?: string;
  onCloseAutoFocus?: ComponentProps<DrawerContent>["onCloseAutoFocus"];
}) {
  const isDesktop = useMediaQuery(RESPONSIVE_QUERIES.abovePhone);
  const close = useRef(onOpenChange);
  close.current = onOpenChange;
  const trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return registerCockpitSheetBack(() => close.current(false));
  }, [open]);
  const side = sideOnDesktop && isDesktop;
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const gateway = getGatewayApiBaseUrl();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const scope = JSON.stringify([gateway, caller, access, activeCitadelId, activeWorkspaceId, title, open]);
  const owner = useMemo<SheetOwner>(() => ({ scope }), [scope]);
  const committedOwner = useRef(owner),
    committedChildren = useRef(children),
    mounted = useRef(true);
  const pendingHost = useRef<HTMLElement | null>(null),
    pendingFocus = useRef<PendingFocus | undefined>(undefined);
  const sdkClose = useRef<HTMLButtonElement>(null),
    drawerCommitted = useRef(Boolean(readLoadedDrawer()));
  const cancelButton = useRef<HTMLButtonElement>(null);
  const activeReview = useRef<ReloadReview | undefined>(undefined),
    returnFocus = useRef<ReloadReview | undefined>(undefined);
  const [code, setCode] = useState<DrawerModule | undefined>(() => readLoadedDrawer());
  const [failedOwner, setFailedOwner] = useState<SheetOwner>();
  const [review, setReview] = useState<ReloadReview>();
  const activation = useRef<PendingFocus | undefined>(undefined);
  const [activationPending, setActivationPending] = useState(false);
  const current = useCallback(
    () =>
      mounted.current &&
      committedOwner.current === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayAccessRevision() === access,
    [owner, gateway, caller, access],
  );
  const failed = failedOwner === owner;
  const currentReview = (saved: ReloadReview) =>
    saved.owner === owner &&
    current() &&
    committedChildren.current === saved.children &&
    readCockpitHistory() === saved.history &&
    window.location.href === saved.url;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeReview.current = undefined;
      returnFocus.current = undefined;
      pendingFocus.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    committedChildren.current = children;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
  }, [owner, history, children]);
  const Drawer = code && !activationPending ? code.Drawer : undefined;
  useLayoutEffect(() => {
    drawerCommitted.current = Boolean(Drawer && open);
  }, [Drawer, open]);
  useLayoutEffect(() => {
    activation.current = undefined;
    setActivationPending(false);
  }, [owner]);
  useEffect(() => {
    if (!open || code) return;
    let active = true;
    void loadDrawer().then(
      (sdk) => {
        if (active && current()) setCode(sdk);
      },
      () => {
        if (active && current()) setFailedOwner(owner);
      },
    );
    return () => {
      active = false;
    };
  }, [open, code, owner, current]);
  useEffect(() => {
    if (!open || Drawer || failed) return;
    let activationTimer: ReturnType<typeof setTimeout> | undefined;
    const clearActivationTimer = () => {
      if (activationTimer !== undefined) {
        clearTimeout(activationTimer);
        activationTimer = undefined;
      }
    };
    const focus = (event: FocusEvent) => {
      const node = event.target;
      // A focus trap may synchronously redirect the event target. Follow actual current focus.
      if (node !== document.activeElement) return;
      if (
        node instanceof HTMLElement &&
        pendingHost.current?.contains(node) &&
        current() &&
        (node.getAttribute("aria-label") === closeLabel || node === pendingHost.current)
      ) {
        pendingFocus.current = { owner, node, kind: node === pendingHost.current ? "panel" : "close" };
        if (activation.current && activation.current.node !== node) releaseActivation();
      } else if (!(node === document.body && pendingFocus.current && !pendingFocus.current.node.isConnected)) {
        pendingFocus.current = undefined;
        releaseActivation();
      }
    };
    const ownedClose = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(`button[aria-label="${CSS.escape(closeLabel)}"]`) : null;
    const releaseActivation = (saved = activation.current) => {
      if (!saved || activation.current !== saved) return;
      clearActivationTimer();
      activation.current = undefined;
      setActivationPending(false);
    };
    const pointer = (event: PointerEvent) => {
      const node = ownedClose(event.target);
      if (event.button === 0 && node && pendingHost.current?.contains(node) && current()) {
        activation.current = { owner, node };
        setActivationPending(true);
      } else {
        pendingFocus.current = undefined;
        releaseActivation();
      }
    };
    const pointerEnd = (event: PointerEvent) => {
      if (event.type === "pointercancel" || ownedClose(event.target) !== activation.current?.node) releaseActivation();
      // An inside release keeps the actual native button through its following click.
    };
    const key = (event: KeyboardEvent) => {
      const node = ownedClose(event.target);
      if (
        !event.defaultPrevented &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "Enter" || event.key === " ") &&
        node &&
        pendingHost.current?.contains(node) &&
        current()
      ) {
        activation.current = { owner, node };
        setActivationPending(true);
      } else if (event.key === "Escape") releaseActivation();
    };
    const keyEnd = (event: KeyboardEvent) => {
      const saved = activation.current;
      if (!saved) return;
      if (ownedClose(event.target) !== saved.node || (event.key !== "Enter" && event.key !== " "))
        releaseActivation(saved);
      else
        queueMicrotask(() => {
          if (current() && event.defaultPrevented) releaseActivation(saved);
        });
    };
    const blur = () => {
      pendingFocus.current = undefined;
      releaseActivation();
    };
    const click = (event: MouseEvent) => {
      const saved = activation.current;
      if (saved && ownedClose(event.target) === saved.node) {
        // Native capture-listener microtasks can run before React dispatches Close.
        // Keep the actual button until its whole native event has completed.
        clearActivationTimer();
        activationTimer = setTimeout(() => {
          activationTimer = undefined;
          if (current() && activation.current === saved) releaseActivation(saved);
        }, 0);
      }
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("pointerup", pointerEnd, true);
    document.addEventListener("pointercancel", pointerEnd, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keyup", keyEnd);
    window.addEventListener("blur", blur);
    return () => {
      clearActivationTimer();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("pointerup", pointerEnd, true);
      document.removeEventListener("pointercancel", pointerEnd, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keyup", keyEnd);
      window.removeEventListener("blur", blur);
    };
  }, [open, Drawer, failed, owner, current, closeLabel]);
  const handoffFocus: NonNullable<ComponentProps<DrawerContent>["onOpenAutoFocus"]> = (event) => {
    const saved = pendingFocus.current;
    pendingFocus.current = undefined;
    pendingHost.current = null;
    if (saved?.owner === owner && current() && !saved.node.isConnected && document.activeElement === document.body) {
      event.preventDefault();
      if (saved.kind === "panel" && event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
      else sdkClose.current?.focus({ preventScroll: true });
    }
  };
  const closeReview = (saved: ReloadReview | undefined) => {
    if (!saved || activeReview.current !== saved) return;
    activeReview.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
  };
  const openReview = (button: HTMLButtonElement) => {
    if (!failed || !current() || activeReview.current) return;
    const saved = { owner, history: readCockpitHistory(), url: window.location.href, children, trigger: button };
    activeReview.current = saved;
    returnFocus.current = saved;
    setReview(saved);
  };
  const reload = (saved: ReloadReview | undefined) => {
    if (hasUnsettledChatContextMutation()) return;
    if (!saved || activeReview.current !== saved || !failed || !currentReview(saved)) return;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
    window.location.reload();
  };
  return (
    <>
      {Drawer ? (
        <Drawer.Root open={open} onOpenChange={onOpenChange} direction={side ? "right" : "bottom"}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
            <Drawer.Content
              // A sheet has a title and no description; say so rather than point at a missing description.
              aria-describedby={undefined}
              onOpenAutoFocus={handoffFocus}
              onCloseAutoFocus={
                onCloseAutoFocus ??
                ((event) => {
                  if (trigger.current?.isConnected) {
                    event.preventDefault();
                    trigger.current.focus();
                  }
                })
              }
              className={
                side
                  ? "fixed inset-y-0 right-0 z-50 h-full w-full max-w-2xl overflow-hidden border-l border-line bg-overlay"
                  : "cockpit-sheet cockpit-safe-bottom fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-lg border border-line bg-overlay"
              }
            >
              <div className={side ? "h-full overflow-y-auto p-4" : "cockpit-sheet-scroll overflow-y-auto p-4"}>
                <div className="mb-3 flex items-center justify-between gap-4">
                  <Drawer.Title className="font-display text-md font-semibold text-fg">{title}</Drawer.Title>
                  <Drawer.Close asChild>
                    <IconButton ref={sdkClose} label={closeLabel} icon={<X aria-hidden="true" className="size-4" />} />
                  </Drawer.Close>
                </div>
                {children}
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      ) : (
        <Dialog
          open={open}
          title={title}
          closeLabel={closeLabel}
          description={failed ? "Sheet controls are unavailable." : "Loading sheet controls."}
          onOpenChange={(value) => {
            if (current()) onOpenChange(value);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            pendingHost.current = event.target instanceof HTMLElement ? event.target : null;
          }}
          onCloseAutoFocus={(event) => {
            if (drawerCommitted.current) {
              event.preventDefault();
              return;
            }
            if (onCloseAutoFocus) {
              onCloseAutoFocus(event);
              return;
            }
            if (trigger.current?.isConnected) {
              event.preventDefault();
              trigger.current.focus();
            }
          }}
        >
          {failed ? (
            <div role="alert" className="min-h-24 space-y-2 text-sm">
              <p>Sheet controls could not load. You can close the sheet and keep using Cockpit, or reload the app.</p>
              <Button size="sm" onClick={(event) => openReview(event.currentTarget)}>
                Reload app
              </Button>
            </div>
          ) : (
            <p role="status" className="min-h-24 text-sm text-fg-muted">
              Loading sheet controls…
            </p>
          )}
        </Dialog>
      )}
      <Dialog
        open={Boolean(review && failed && currentReview(review))}
        title="Reload app?"
        onOpenChange={(value) => {
          if (!value) closeReview(review);
        }}
        description="Reloading keeps recorded work. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (review && activeReview.current === review && currentReview(review))
            cancelButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const saved = returnFocus.current;
          returnFocus.current = undefined;
          if (
            saved &&
            currentReview(saved) &&
            saved.trigger.isConnected &&
            (document.activeElement === document.body || document.activeElement === saved.trigger)
          )
            saved.trigger.focus({ preventScroll: true });
        }}
      >
        <div className="flex justify-end gap-2">
          <Button ref={cancelButton} onClick={() => closeReview(review)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={hasUnsettledChatContextMutation() || !review || !currentReview(review)}
            title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
            onClick={() => reload(review)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </>
  );
}
