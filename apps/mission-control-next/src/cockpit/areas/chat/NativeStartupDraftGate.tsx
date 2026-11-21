import { lazy, Suspense, type ComponentProps } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import type { StartupDraftContext } from "./startup-draft-bridge";

const StartupDraftBridge = lazy(async () => ({ default: (await import("./startup-draft-bridge")).StartupDraftBridge }));

export function startupDraftFor(
  active: MissionThreadedActiveSessionSurfaceProps | null | undefined,
  workspaceId: string | undefined,
  selectedSessionId: string | undefined,
  recordId: string | undefined,
): StartupDraftContext | undefined {
  if (
    !active?.draftHydrated ||
    !selectedSessionId ||
    active.selectedSessionId !== selectedSessionId ||
    recordId !== selectedSessionId
  )
    return undefined;
  return {
    key: JSON.stringify([workspaceId, selectedSessionId]),
    label: active.sessionTitle || "this conversation",
    newChat: active.thread?.sessionId === selectedSessionId && active.thread.turns.length === 0,
  };
}

export function NativeStartupDraftGate(props: ComponentProps<typeof StartupDraftBridge>) {
  const host = typeof window !== "undefined" && (window as Window & { chrome?: { webview?: unknown } }).chrome?.webview;
  if (!host || !props.destination) return null;
  return (
    <Suspense fallback={null}>
      <StartupDraftBridge {...props} />
    </Suspense>
  );
}
