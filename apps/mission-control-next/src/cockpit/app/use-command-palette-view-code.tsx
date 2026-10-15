import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { readCockpitHistory, subscribeCockpitHistory } from "./cockpit-history";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
type PaletteCode = typeof import("./CommandPaletteView");
type Owner = { scope: string };
type Kind = "input" | "created";
type FocusIntent = {
  owner: Owner;
  node: HTMLElement;
  kind: Kind;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
};
type Activation = { owner: Owner; node: HTMLElement; kind: Kind };
type ReloadReview = { owner: Owner; history: string; url: string; trigger: HTMLButtonElement };
let paletteLoad: Promise<PaletteCode> | undefined;
let loadedPalette: PaletteCode | undefined;
function loadPaletteCode() {
  paletteLoad ??= import("./CommandPaletteView").then((code) => {
    loadedPalette = code;
    return code;
  });
  return paletteLoad;
}
/** Only optional palette code/focus/recovery. Query, drafts, attempts and actions keep their existing owners. */
export function useCommandPaletteViewCode(
  open: boolean,
  workspaceId: string | null | undefined,
  citadelId: string | null | undefined,
  canReload: () => boolean,
) {
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const gateway = getGatewayApiBaseUrl();
  const scope = JSON.stringify([gateway, caller, access, workspaceId, citadelId, open]);
  const owner = useMemo<Owner>(() => ({ scope }), [scope]);
  const committedOwner = useRef(owner),
    mounted = useRef(true);
  const input = useRef<HTMLInputElement | null>(null),
    createdButton = useRef<HTMLButtonElement | null>(null);
  const pendingHost = useRef<HTMLDivElement | null>(null),
    pendingMode = useRef(true),
    focusIntent = useRef<FocusIntent | undefined>(undefined);
  const activation = useRef<Activation | undefined>(undefined);
  const [code, setCode] = useState<PaletteCode | undefined>(() => loadedPalette),
    [failedOwner, setFailedOwner] = useState<Owner>();
  const [composing, setComposing] = useState(false),
    [activationPending, setActivationPending] = useState(false);
  const [review, setReview] = useState<ReloadReview>();
  const activeReview = useRef<ReloadReview | undefined>(undefined),
    returnFocus = useRef<ReloadReview | undefined>(undefined),
    cancelReload = useRef<HTMLButtonElement>(null);
  const current = useCallback(
    () =>
      mounted.current &&
      committedOwner.current === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayAccessRevision() === access,
    [owner, gateway, caller, access],
  );
  const currentReview = (saved: ReloadReview) =>
    saved.owner === owner &&
    current() &&
    readCockpitHistory() === saved.history &&
    window.location.href === saved.url &&
    canReload();
  const View = code && !composing && !activationPending ? code.CommandPaletteView : undefined;
  const failed = !code && failedOwner === owner;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      focusIntent.current = undefined;
      activation.current = undefined;
      activeReview.current = undefined;
      returnFocus.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    focusIntent.current = undefined;
    activation.current = undefined;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
    setActivationPending(false);
    setComposing(false);
  }, [owner]);
  useLayoutEffect(() => {
    pendingMode.current = !View;
  }, [View]);
  useLayoutEffect(() => {
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
  }, [history]);
  useEffect(() => {
    if (!open || code) return;
    let active = true;
    void loadPaletteCode().then(
      (ready) => {
        if (active && current()) setCode(ready);
      },
      () => {
        if (active && current()) setFailedOwner(owner);
      },
    );
    return () => {
      active = false;
    };
  }, [open, code, owner, current]);
  const registerControl = useCallback(
    (kind: Kind, node: HTMLElement | null) => {
      const target = kind === "input" ? input : createdButton,
        previous = target.current;
      if (!node && previous && pendingMode.current && document.activeElement === previous && current()) {
        const field = previous instanceof HTMLInputElement ? previous : undefined;
        focusIntent.current = {
          owner,
          node: previous,
          kind,
          start: field?.selectionStart ?? null,
          end: field?.selectionEnd ?? null,
          direction: field?.selectionDirection ?? null,
        };
      }
      if (kind === "input") input.current = node as HTMLInputElement | null;
      else createdButton.current = node as HTMLButtonElement | null;
      const saved = focusIntent.current;
      if (
        node &&
        saved?.owner === owner &&
        saved.kind === kind &&
        !saved.node.isConnected &&
        document.activeElement === document.body &&
        current()
      ) {
        focusIntent.current = undefined;
        node.focus({ preventScroll: true });
        if (node instanceof HTMLInputElement && saved.start !== null && saved.end !== null)
          node.setSelectionRange(
            Math.min(saved.start, node.value.length),
            Math.min(saved.end, node.value.length),
            saved.direction ?? undefined,
          );
      }
    },
    [owner, current],
  );
  const inputRef = useCallback((node: HTMLInputElement | null) => registerControl("input", node), [registerControl]);
  const createdRef = useCallback(
    (node: HTMLButtonElement | null) => registerControl("created", node),
    [registerControl],
  );
  useEffect(() => {
    if (!open || View || failed) return;
    let releaseTimer: number | undefined;
    const release = (saved = activation.current) => {
      if (saved && activation.current === saved) {
        if (releaseTimer !== undefined) {
          window.clearTimeout(releaseTimer);
          releaseTimer = undefined;
        }
        activation.current = undefined;
        setActivationPending(false);
      }
    };
    const releaseAfterPointer = (saved: Activation) => {
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        releaseTimer = undefined;
        if (current()) release(saved);
      }, 0);
    };
    const ownedControl = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const node = target.closest<HTMLElement>('input,button[data-palette-created="true"]');
      return node && pendingHost.current?.contains(node) ? node : null;
    };
    const pointer = (event: PointerEvent) => {
      const node = ownedControl(event.target);
      if (event.button === 0 && node && current()) {
        activation.current = { owner, node, kind: node === input.current ? "input" : "created" };
        setActivationPending(true);
      } else release();
    };
    const endPointer = (event: PointerEvent) => {
      const saved = activation.current;
      if (!saved) return;
      if (event.type === "pointercancel") release(saved);
      else if (saved.kind === "input") releaseAfterPointer(saved);
      else if (ownedControl(event.target) !== saved.node) release(saved);
    };
    const key = (event: KeyboardEvent) => {
      const node = ownedControl(event.target);
      if (
        !event.defaultPrevented &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "Enter" || event.key === " ") &&
        node &&
        node === createdButton.current &&
        current()
      ) {
        activation.current = { owner, node, kind: "created" };
        setActivationPending(true);
      } else if (event.key === "Escape") release();
    };
    const endKey = (event: KeyboardEvent) => {
      const saved = activation.current;
      if (!saved) return;
      if (
        saved.kind === "input" ||
        ownedControl(event.target) !== saved.node ||
        (event.key !== "Enter" && event.key !== " ")
      )
        release(saved);
      else
        queueMicrotask(() => {
          if (current() && event.defaultPrevented) release(saved);
        });
    };
    const click = (event: MouseEvent) => {
      const saved = activation.current;
      if (saved?.kind === "input") releaseAfterPointer(saved);
      else if (saved && ownedControl(event.target) === saved.node)
        queueMicrotask(() => {
          if (current()) release(saved);
        });
    };
    const focus = (event: FocusEvent) => {
      if (event.target !== document.activeElement) return;
      if (activation.current && event.target !== activation.current.node) release();
      if (event.target !== input.current && event.target !== createdButton.current) focusIntent.current = undefined;
    };
    const blur = () => {
      focusIntent.current = undefined;
      release();
      setComposing(false);
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("pointerup", endPointer, true);
    document.addEventListener("pointercancel", endPointer, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", endKey);
    document.addEventListener("click", click, true);
    document.addEventListener("focusin", focus);
    window.addEventListener("blur", blur);
    return () => {
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("pointerup", endPointer, true);
      document.removeEventListener("pointercancel", endPointer, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", endKey);
      document.removeEventListener("click", click, true);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("blur", blur);
    };
  }, [open, View, failed, owner, current]);
  const closeReview = (saved: ReloadReview | undefined) => {
    if (!saved || activeReview.current !== saved) return;
    activeReview.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
  };
  const openReload = (trigger: HTMLButtonElement) => {
    if (!failed || !current() || !canReload() || activeReview.current) return;
    const saved = { owner, history: readCockpitHistory(), url: window.location.href, trigger };
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
  const recovery = (
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
          cancelReload.current?.focus({ preventScroll: true });
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
        <Button ref={cancelReload} onClick={() => closeReview(review)}>
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
  );
  return {
    code,
    View,
    failed,
    reloadAllowed: canReload(),
    inputRef,
    createdRef,
    pendingHost,
    setComposing,
    openReload,
    recovery,
    onOpenAutoFocus: (event: Event) => {
      event.preventDefault();
      if (current()) input.current?.focus({ preventScroll: true });
    },
  };
}
