import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

const type = "goatcitadel.startup-draft";
const limit = 16_384;
const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface StartupDraftContext {
  key: string;
  label: string;
  newChat: boolean;
}

interface Snapshot {
  label: string;
  newChat: boolean;
  draft: string;
  composer: HTMLTextAreaElement;
  changeDraft(text: string): void;
}

interface WebView {
  postMessage(message: object): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export function connectStartupDraft(
  bridge: WebView,
  origin: string,
  context: string,
  commitAutomatic?: (apply: () => void) => void,
) {
  let current: Snapshot | undefined;
  let readiness: string | undefined;
  let pending: { offer: string; text: string; focus: boolean } | undefined;
  const receipts = new Map<string, "applied" | "held">();

  function post(message: object) {
    bridge.postMessage({ type, version: 1, context, ...message });
  }

  function acknowledge(offer: string, outcome: "applied" | "held") {
    receipts.set(offer, outcome);
    post({ action: "ack", offer, outcome });
  }

  function receive(event: MessageEvent) {
    const value = event.data;
    if (value?.type !== type || value.version !== 1 || value.action !== "offer" ||
        value.origin !== origin || (event.origin && event.origin !== origin) || value.context !== context ||
        typeof value.offer !== "string" || !id.test(value.offer) || typeof value.text !== "string" ||
        !value.text.trim() || value.text.length > limit || typeof value.append !== "boolean") return;

    const previous = receipts.get(value.offer);
    if (previous) {
      post({ action: "ack", offer: value.offer, outcome: previous });
      return;
    }
    if (pending || receipts.size >= 64) return;
    if (!current || current.composer.value !== current.draft || current.composer.disabled ||
        current.composer.readOnly || (!value.append && (!current.newChat || current.draft !== ""))) {
      acknowledge(value.offer, "held");
      return;
    }

    const normalized = value.text.replace(/\r\n?/g, "\n");
    const text = current.draft ? current.draft + "\n\n" + normalized : normalized;
    const { changeDraft } = current;
    pending = { offer: value.offer, text, focus: value.focus === true };
    if (!value.append && commitAutomatic) {
      // WebView messages arrive outside React's discrete input events. Commit the
      // admitted automatic transfer with the same urgency as a typed character.
      commitAutomatic(() => changeDraft(text));
    } else {
      changeDraft(text);
    }
  }

  bridge.addEventListener("message", receive);
  return {
    update(snapshot: Snapshot | undefined) {
      current = snapshot;
      if (pending && snapshot) {
        const transfer = pending;
        pending = undefined;
        const applied = snapshot.draft === transfer.text && snapshot.composer.value === transfer.text;
        if (applied && transfer.focus) {
          snapshot.composer.focus();
          snapshot.composer.setSelectionRange(transfer.text.length, transfer.text.length);
        }
        acknowledge(transfer.offer, applied ? "applied" : "held");
      }
      const label = snapshot?.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "this conversation";
      const automatic = Boolean(snapshot?.newChat && snapshot.draft === "");
      const next = snapshot ? JSON.stringify([label, automatic]) : undefined;
      if (readiness === next) return;
      readiness = next;
      post(snapshot ? { action: "ready", label, automatic } : { action: "unavailable" });
    },
    disconnect() {
      bridge.removeEventListener("message", receive);
      if (readiness !== undefined) post({ action: "unavailable" });
    },
  };
}

export function useStartupDraftBridge(
  destination: StartupDraftContext | undefined,
  allowed: boolean,
  draft: string,
  composerRef: RefObject<HTMLTextAreaElement | null>,
  changeDraft: (text: string) => void,
) {
  const connection = useRef<ReturnType<typeof connectStartupDraft> | null>(null);
  const key = destination?.key;
  useLayoutEffect(() => {
    const host = (window as Window & { chrome?: { webview?: WebView } }).chrome?.webview;
    if (!key || !host || window.top !== window || !window.crypto.randomUUID) return;
    const bridge = connectStartupDraft(host, window.location.origin, window.crypto.randomUUID(), flushSync);
    connection.current = bridge;
    return () => {
      bridge.disconnect();
      connection.current = null;
    };
  }, [key]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    connection.current?.update(destination && allowed && composer && !composer.disabled && !composer.readOnly
      ? { label: destination.label, newChat: destination.newChat, draft, composer, changeDraft }
      : undefined);
  });
}
