import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useScopedOperation } from "@goatcitadel/mission-control-shared/hooks/use-scoped-operation";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { captureMutationAttempt, getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  describeApiError,
  GATEWAY_UNREACHABLE_SUMMARY,
} from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import {
  readApprovalOperationAttempt,
  updateApprovalOperationEvidence,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import type { ChatContextMutationProjection, ChatContextMutationKind } from "./context-mutation-projection";

type RevisionRef = { readonly current: number };
type Input = {
  family: "specialists" | "learned-memory" | "binding";
  workspaceId: string;
  sessionId: string | null;
  sessionWorkspaceId?: string;
  historicalRevisionRef?: RevisionRef;
  historicalReadOnly?: boolean;
  selectionRevisionRef?: RevisionRef;
  turnRevisionRef?: RevisionRef;
  sendingRevisionRef?: RevisionRef;
  setError: (value: string | null) => void;
};
const ROUTES = [
  "/api/v1/chat/sessions/:sessionId/specialist-candidates",
  "/api/v1/chat/sessions/:sessionId/specialist-candidates/:candidateId",
  "/api/v1/agents/catalog/:entryId/activate-session",
  "/api/v1/chat/sessions/:sessionId/learned-memory/:itemId",
  "/api/v1/chat/sessions/:sessionId/learned-memory/rebuild",
  "/api/v1/chat/sessions/:sessionId/binding",
] as const;
/** Existing shared attempts remain the sole lock and settlement owner. */
export function useChatContextMutationOwner(input: Input) {
  const {
    family,
    workspaceId,
    sessionId,
    sessionWorkspaceId,
    historicalRevisionRef,
    historicalReadOnly,
    selectionRevisionRef,
    turnRevisionRef,
    sendingRevisionRef,
    setError,
  } = input;
  const preferences = useUiPreferences();
  const operation = useScopedOperation(JSON.stringify(["chat-context", workspaceId, sessionId]));
  const {
    current: operationCurrent,
    key: operationKey,
    run: runOperation,
    attempt: operationAttempt,
    locked: operationLocked,
  } = operation;
  const scopeGeneration = preferences.scopeGenerationRef?.current ?? 0;
  const historicalRevision = historicalRevisionRef?.current ?? 0;
  const selectionRevision = selectionRevisionRef?.current ?? 0;
  const turnRevision = turnRevisionRef?.current ?? 0;
  const lifetime = useRef(0);
  const [, publishLifetime] = useState(0);
  const renderedLifetime = lifetime.current;
  const scopeIdentity = JSON.stringify([
    operation.identity,
    scopeGeneration,
    selectionRevision,
    turnRevision,
    historicalRevision,
    historicalReadOnly,
    renderedLifetime,
  ]);
  const committed = useRef(scopeIdentity);
  const active = useRef(true);
  const [, publishScopeCommit] = useState(scopeIdentity);
  useLayoutEffect(() => {
    committed.current = scopeIdentity;
    publishScopeCommit(scopeIdentity);
  }, [scopeIdentity]);
  const pendingBusyRelease = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    // Effect replay and Activity reveal must publish fresh admission after revoking the old lifetime.
    publishLifetime(lifetime.current);
    pendingBusyRelease.current?.();
    pendingBusyRelease.current = null;
    return () => {
      active.current = false;
      lifetime.current += 1;
    };
  }, []);
  const current = useCallback(
    () =>
      (sessionWorkspaceId === undefined || sessionWorkspaceId === workspaceId) &&
      !historicalReadOnly &&
      (historicalRevisionRef?.current ?? 0) === historicalRevision &&
      active.current &&
      lifetime.current === renderedLifetime &&
      committed.current === scopeIdentity &&
      operationCurrent() &&
      (preferences.scopeGenerationRef?.current ?? 0) === scopeGeneration &&
      (selectionRevisionRef?.current ?? 0) === selectionRevision &&
      (turnRevisionRef?.current ?? 0) === turnRevision,
    [
      scopeIdentity,
      renderedLifetime,
      sessionWorkspaceId,
      workspaceId,
      historicalRevision,
      historicalReadOnly,
      historicalRevisionRef,
      operationCurrent,
      preferences.scopeGenerationRef,
      selectionRevisionRef,
      turnRevisionRef,
      scopeGeneration,
      selectionRevision,
      turnRevision,
    ],
  );
  const [notice, setNotice] = useState<{
    scope: string;
    message?: string;
    inspectionError?: string;
    refused?: boolean;
  }>();
  const run = useCallback(
    async <T>(
      kind: ChatContextMutationKind,
      dispatch: () => Promise<T>,
      validate: (receipt: T) => readonly string[],
      publish: (receipt: T, publicationCurrent: () => boolean) => void,
      busy?: { begin: () => void; end: () => void; revisionRef?: RevisionRef },
    ): Promise<void> => {
      const callerRevision = getGatewayCallerScopeRevision();
      let began = false;
      let dispatched = false;
      let busyRevision: number | undefined;
      const busyRevisionRef = busy?.revisionRef ?? sendingRevisionRef;
      const isCurrent = () =>
        current() &&
        getGatewayCallerScopeRevision() === callerRevision &&
        (dispatched || !began || !busyRevisionRef || busyRevisionRef.current === busyRevision);
      if (!sessionId || !isCurrent()) return;
      let attemptToken: symbol | undefined;
      try {
        const receipt = await runOperation(
          crypto.randomUUID(),
          async () => {
            if (!isCurrent()) throw new Error("Conversation access changed before submission.");
            attemptToken = readApprovalOperationAttempt(operationKey)?.token;
            if (busy) {
              busy.begin();
              began = true;
              busyRevision = busyRevisionRef?.current;
            }
          },
          () => {
            dispatched = true;
            return captureMutationAttempt(
              async () => {
                try {
                  return await dispatch();
                } catch (cause) {
                  // These legacy handlers may answer400 after a partial write. Preserve that uncertainty.
                  if (isApiRequestError(cause) && cause.kind === "http" && cause.status === 400)
                    throw new Error("The Gateway rejected the request; its commit outcome is not confirmed.", {
                      cause,
                    });
                  throw cause;
                }
              },
              (request) => {
                if (attemptToken) updateApprovalOperationEvidence(operationKey, attemptToken, { request });
              },
            );
          },
          (result) => {
            const subjectIds = validate(result);
            if (attemptToken)
              updateApprovalOperationEvidence(operationKey, attemptToken, {
                receipt: { kind, subjectIds: [...subjectIds] },
              });
          },
          false,
          isCurrent,
        );
        if (receipt === undefined) {
          if (attemptToken && !dispatched && current() && getGatewayCallerScopeRevision() === callerRevision)
            setNotice({
              scope: scopeIdentity,
              message: "No action was submitted; the reviewed execution state changed before dispatch.",
              refused: true,
            });
          return;
        }
        if (!isCurrent()) return;
        try {
          publish(receipt, isCurrent);
          setNotice({ scope: scopeIdentity });
        } catch (cause) {
          // The canonical effect remains confirmed even when local publication fails.
          setNotice({
            scope: scopeIdentity,
            inspectionError:
              "The mutation receipt is confirmed, but its display could not refresh. " +
              describeApiError(cause).summary,
          });
        }
      } catch (cause) {
        if (isCurrent()) {
          const attempt = readApprovalOperationAttempt(operationKey);
          // A missing mutation response does not establish Gateway reachability.
          // Retain the shared lock and use the explicit unknown-outcome projection.
          const described = describeApiError(cause).summary;
          const unknownTransport = attempt?.phase === "uncertain" && described.startsWith(GATEWAY_UNREACHABLE_SUMMARY);
          const message = unknownTransport ? undefined : described;
          if (message) setError(message);
          setNotice({ scope: scopeIdentity, message, refused: !attempt });
        }
      } finally {
        if (began) {
          const release = () => {
            if (busyRevisionRef ? busyRevisionRef.current === busyRevision : isCurrent()) busy?.end();
          };
          if (active.current) release();
          else pendingBusyRelease.current = release;
        }
      }
    },
    [scopeIdentity, current, operationKey, runOperation, sessionId, setError, sendingRevisionRef],
  );
  const inspect = useCallback(
    async <T>(
      read: () => Promise<T>,
      validate: (value: T) => void,
      publish: (value: T, publicationCurrent: () => boolean) => void,
    ): Promise<void> => {
      const callerRevision = getGatewayCallerScopeRevision();
      const isCurrent = () => current() && getGatewayCallerScopeRevision() === callerRevision;
      if (!sessionId || !isCurrent()) return;
      try {
        const attempt = readApprovalOperationAttempt(operationKey);
        let message: string | undefined;
        if (attempt?.phase === "uncertain") {
          const { classifyMutationAttempt, fetchMutationAttempt, matchRoutePattern } =
            await import("@goatcitadel/mission-control-shared/api/mutation-attempts");
          if (!isCurrent()) return;
          const request = attempt.request;
          const route = request && matchRoutePattern(request.path, ROUTES);
          if (
            !request ||
            !route ||
            request.installation !== getGatewayApiBaseUrl() ||
            !["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
          ) {
            message =
              "The original request has no inspectable canonical attempt linkage. Its write outcome remains unknown and locked.";
          } else {
            const status = await fetchMutationAttempt(
              request.attemptKey,
              request.method as "POST" | "PATCH" | "PUT" | "DELETE",
              route,
            );
            if (!isCurrent()) return;
            const verdict = classifyMutationAttempt(status);
            message =
              verdict === "in_progress"
                ? "The Gateway is still processing the original request. Further writes remain locked."
                : verdict === "committed"
                  ? "The Gateway marked the original request completed, but returned no canonical subject linkage. Current records do not settle that original effect; writes remain locked."
                  : "The original request has no confirmed canonical effect linkage. Its write outcome remains unknown and locked.";
          }
        }
        if (!isCurrent()) return;
        const value = await read();
        validate(value);
        if (!isCurrent()) return;
        publish(value, isCurrent);
        setNotice({ scope: scopeIdentity, message });
        // Inspection never releases or replays an uncertain mutation.
      } catch (cause) {
        if (isCurrent())
          setNotice({
            scope: scopeIdentity,
            inspectionError: "Inspecting current records failed. " + describeApiError(cause).summary,
          });
      }
    },
    [scopeIdentity, current, operationKey, sessionId],
  );
  const projection = useMemo<Omit<ChatContextMutationProjection, "onInspect">>(() => {
    const ownedNotice = notice?.scope === scopeIdentity ? notice : undefined;
    const attempt = operationAttempt;
    const ownReceipt =
      attempt?.receipt &&
      (family === "specialists"
        ? attempt.receipt.kind.startsWith("specialist-")
        : family === "learned-memory"
          ? attempt.receipt.kind.startsWith("learned-memory-")
          : attempt.receipt.kind === "external-binding")
        ? attempt.receipt
        : undefined;
    const phase =
      attempt?.phase === "resolved" && !ownReceipt
        ? "idle"
        : (attempt?.phase ?? (ownedNotice?.refused ? "refused" : "idle"));
    return {
      family: family,
      workspaceId: workspaceId,
      sessionId: sessionId,
      scopeIdentity,
      phase,
      locked: operationLocked,
      isCurrent: current,
      message:
        ownedNotice?.message ??
        (phase === "uncertain"
          ? "The original mutation outcome is unknown. Further writes remain locked; inspecting current records cannot settle or replay it."
          : phase === "resolved"
            ? "The Gateway returned the canonical mutation receipt."
            : phase === "idle"
              ? undefined
              : attempt?.message),
      inspectionError: ownedNotice?.inspectionError,
      receipt: ownReceipt,
    };
  }, [notice, scopeIdentity, operationAttempt, operationLocked, current, family, workspaceId, sessionId]);
  return { run, inspect, projection };
}
