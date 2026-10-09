import { useSyncExternalStore } from "react";
import { canonicalJsonString, type IntegrationConnection } from "@goatcitadel/contracts";
import { isApiRequestError, updateIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { dispatchTrackedMutation, settleTrackedAttempt, type TrackedAttempt } from "./mutation-attempt-tracking";

type UpdateInput = Parameters<typeof updateIntegrationConnection>[1];
/** `transport` identifies a lost write (key, method, route; never its body) so its outcome can be read. */
interface Attempt {
  phase: "idle" | "saving" | "saved" | "uncertain";
  message?: string;
  transport?: TrackedAttempt;
  checking?: boolean;
}
/** The Gateway routes the integration owners write through; a lost write on any other route is not checkable. */
export const INTEGRATION_ROUTE_PATTERNS = [
  "/api/v1/integrations/connections",
  "/api/v1/integrations/connections/:connectionId",
  "/api/v1/integrations/connections/:connectionId/actions/:actionId",
  "/api/v1/integrations/connections/:connectionId/discord/reconnect",
  "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/actions/:actionId/stage",
  "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/actions/:actionId/review",
  "/api/v1/integrations/plugins/install",
  "/api/v1/integrations/plugins/:pluginId/enable",
  "/api/v1/integrations/plugins/:pluginId/disable",
  "/api/v1/notifications/rules",
  "/api/v1/notifications/rules/:ruleId",
  "/api/v1/notifications/targets",
  "/api/v1/notifications/targets/:targetId",
  "/api/v1/notifications/targets/:targetId/test",
  "/api/v1/notifications/presence",
  "/api/v1/workspaces/:workspaceId/hooks",
  "/api/v1/workspaces/:workspaceId/hooks/:hookId",
  "/api/v1/workspaces/:workspaceId/hooks/:hookId/test",
  "/api/v1/workspaces/:workspaceId/hooks/runs/:runId/redrive",
  "/api/v1/voice/google-meet/sessions",
  "/api/v1/voice/google-meet/sessions/:sessionId/stop",
  "/api/v1/voice/realtime/client-secret",
  "/api/v1/durable/runs",
  "/api/v1/channels/drafts/:draftId",
] as const;
const CHECKABLE = " Check its outcome to settle it from the Gateway's record of this attempt.";
const IDLE: Attempt = { phase: "idle" };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const getAttempt = (id: string) => attempts.get(id) ?? IDLE;
function setAttempt(id: string, next: Attempt) {
  attempts.set(id, next);
  for (const listener of listeners) listener();
}
export function readIntegrationAttempt(id: string) {
  return getAttempt(id);
}
/**
 * Settles an uncertain integration write from the Gateway's record of that exact attempt and the owner's canonical
 * `readback`. Only a committed or released attempt unlocks; anything else keeps the lock. Returns the settled notice.
 */
export async function checkIntegrationAttemptOutcome(id: string, readback: () => Promise<unknown>) {
  const current = getAttempt(id);
  if (current.phase !== "uncertain" || !current.transport || current.checking) return undefined;
  const checking = { ...current, checking: true };
  setAttempt(id, checking);
  const result = await settleTrackedAttempt(current.transport, readback, "integration change");
  if (getAttempt(id) !== checking) return undefined;
  setAttempt(id, result.settled ? IDLE : { ...current, message: result.message });
  return result.settled ? result.message : undefined;
}
export function useIntegrationConnectionMutation(id: string) {
  const attempt = useSyncExternalStore(
    subscribe,
    () => getAttempt(id),
    () => IDLE,
  );
  return {
    ...attempt,
    pending: attempt.phase === "saving",
    locked: ["saving", "uncertain"].includes(attempt.phase),
    /** Settles this key's lost write; see checkIntegrationAttemptOutcome. */
    checkOutcome: (readback: () => Promise<unknown>) => checkIntegrationAttemptOutcome(id, readback),
  };
}
export function hasIntegrationConnectionBinding(
  value: IntegrationConnection | undefined | null,
): value is IntegrationConnection {
  return Boolean(
    value &&
    typeof value.connectionId === "string" &&
    value.connectionId &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.catalogId === "string" &&
    value.catalogId &&
    typeof value.key === "string" &&
    typeof value.kind === "string" &&
    typeof value.label === "string" &&
    typeof value.enabled === "boolean" &&
    value.config &&
    typeof value.config === "object" &&
    !Array.isArray(value.config),
  );
}
function sameIdentity(a: IntegrationConnection, b: IntegrationConnection) {
  return (
    a.connectionId === b.connectionId &&
    a.catalogId === b.catalogId &&
    a.kind === b.kind &&
    a.key === b.key &&
    a.workspaceId === b.workspaceId &&
    a.createdAt === b.createdAt &&
    a.pluginId === b.pluginId &&
    a.pluginVersion === b.pluginVersion &&
    a.pluginEnabled === b.pluginEnabled
  );
}
export function integrationConnectionReviewMatches(a: IntegrationConnection, b: IntegrationConnection) {
  return (
    hasIntegrationConnectionBinding(a) &&
    hasIntegrationConnectionBinding(b) &&
    sameIdentity(a, b) &&
    a.revision === b.revision &&
    a.enabled === b.enabled
  );
}
function receiptMatches(previous: IntegrationConnection, input: UpdateInput, saved: IntegrationConnection) {
  return (
    hasIntegrationConnectionBinding(saved) &&
    sameIdentity(previous, saved) &&
    saved.revision !== previous.revision &&
    saved.enabled === (input.enabled ?? previous.enabled) &&
    saved.label === (input.label ?? previous.label) &&
    saved.status === (input.status ?? previous.status) &&
    (input.config !== undefined || canonicalJsonString(saved.config) === canonicalJsonString(previous.config))
  );
}
export function integrationConflictIsUncommitted(error: unknown, connectionId: string, method = "PATCH") {
  if (!isApiRequestError(error) || !error.body || typeof error.body !== "object") return false;
  if (error.method !== method || error.path !== `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`)
    return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  if (
    body.mutationCommitted === true ||
    body.committed === true ||
    details?.mutationCommitted === true ||
    details?.committed === true
  )
    return false;
  return (
    // The owner returns this reason only: it does not echo the connection ID or expected revision.
    // Bind the error to the exact transport request; the submitted revision was checked above and by owner CAS.
    (error.status === 409 &&
      body.code === "WRITE_CONFLICT" &&
      details?.reason === "INTEGRATION_CONNECTION_REVISION_CONFLICT") ||
    (error.status === 404 && body.code === "ENTITY_NOT_FOUND")
  );
}

export type IntegrationUpdateResult =
  | { status: "saved"; connection: IntegrationConnection }
  | { status: "cancelled" | "conflict" | "uncertain" | "locked"; message: string };

/** One update owner for both shells; this registry holds UI retry locks, never runtime authority or configuration. */
export async function commitIntegrationConnectionUpdate({
  reviewed,
  input,
  isCurrent,
  verify,
}: {
  reviewed: IntegrationConnection;
  input: UpdateInput;
  isCurrent: () => boolean;
  verify?: (receipt: IntegrationConnection) => Promise<void>;
}): Promise<IntegrationUpdateResult> {
  const id = reviewed.connectionId;
  if (["saving", "uncertain"].includes(getAttempt(id).phase)) {
    return {
      status: "locked",
      message: getAttempt(id).message ?? "A connection change is still awaiting its owner response.",
    };
  }
  if (!isCurrent() || !hasIntegrationConnectionBinding(reviewed) || input.expectedRevision !== reviewed.revision) {
    return { status: "cancelled", message: "Review the current connection before saving." };
  }
  setAttempt(id, { phase: "saving" });
  let transport: TrackedAttempt | undefined;
  try {
    const updated = await dispatchTrackedMutation(
      INTEGRATION_ROUTE_PATTERNS,
      () => updateIntegrationConnection(id, input),
      (tracked) => {
        transport = tracked;
      },
    );
    if (!receiptMatches(reviewed, input, updated)) throw new Error("Unverified connection receipt");
    await verify?.(updated);
    setAttempt(id, { phase: "saved", message: "Connection change acknowledged by the Gateway." });
    return { status: "saved", connection: updated };
  } catch (error) {
    if (integrationConflictIsUncommitted(error, id)) {
      setAttempt(id, IDLE);
      return {
        status: "conflict",
        message: "The connection changed or was deleted. Review its current saved state before retrying.",
      };
    }
    const message =
      "The connection change outcome is unconfirmed. Refresh and inspect the saved connection. Repeating its update is locked for this app session." +
      (transport ? CHECKABLE : "");
    setAttempt(id, { phase: "uncertain", message, ...(transport ? { transport } : {}) });
    return { status: "uncertain", message };
  }
}

/** Retained admission for the existing integration owners, shared by both shells. */
export function beginIntegrationMutation(key: string) {
  if (["saving", "uncertain"].includes(getAttempt(key).phase)) return undefined;
  const pending: Attempt = { phase: "saving" };
  setAttempt(key, pending);
  return {
    async write<T>(
      dispatch: () => Promise<T>,
      verify: (receipt: T) => void | Promise<void>,
      knownRejected?: (error: unknown) => boolean,
    ) {
      let transport: TrackedAttempt | undefined;
      try {
        const receipt = await dispatchTrackedMutation(INTEGRATION_ROUTE_PATTERNS, dispatch, (tracked) => {
          transport = tracked;
        });
        await verify(receipt);
        return receipt;
      } catch (error) {
        if (!knownRejected?.(error))
          setAttempt(key, {
            phase: "uncertain",
            message:
              "The integration action outcome is uncertain. Further attempts are locked in this app session. Inspect the Gateway owner and recorded evidence before continuing." +
              (transport ? CHECKABLE : ""),
            ...(transport ? { transport } : {}),
          });
        throw error;
      }
    },
    finish() {
      if (getAttempt(key) === pending) setAttempt(key, IDLE);
    },
  };
}
export function __resetIntegrationConnectionMutationsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
