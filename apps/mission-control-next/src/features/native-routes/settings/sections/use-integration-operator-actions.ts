import { useRef, useState } from "react";
import { canonicalJsonString, type IntegrationOperatorAction } from "@goatcitadel/contracts";
import {
  fetchIntegrationCatalog,
  fetchIntegrationConnection,
  fetchIntegrationConnectionDiagnostics,
  invokeIntegrationConnectionAction,
} from "@goatcitadel/mission-control-shared/api/client";
import { applyIntegrationDefaults } from "../helpers/channel-helpers";
import { getErrorMessage } from "../SettingsShared";
import { beginIntegrationMutation, hasIntegrationConnectionBinding } from "../integration-connection-mutation";
import type { IntegrationSettingsState } from "./use-integration-settings-state";

export type IntegrationOperatorReview = {
  connection: NonNullable<IntegrationSettingsState["selectedConnection"]>;
  action: IntegrationOperatorAction;
  input: Parameters<typeof invokeIntegrationConnectionAction>[2];
  isCurrent: () => boolean;
};

export function useIntegrationOperatorActions(s: IntegrationSettingsState) {
  const draftSignature = canonicalJsonString(s.actionDraft.value);
  const draftGeneration = useRef({ signature: draftSignature });
  if (draftGeneration.current.signature !== draftSignature) draftGeneration.current = { signature: draftSignature };
  const [operatorReview, setOperatorReview] = useState<IntegrationOperatorReview | null>(null);
  const [diagnosticsPending, setDiagnosticsPending] = useState(false);
  const diagnosticsBusy = useRef(false);
  const visibleOperation = useRef<object | null>(null);
  const handleDiagnostics = async () => {
    const connection = s.selectedConnection;
    if (!connection || !s.isCurrent() || diagnosticsBusy.current) return;
    if (!s.data?.connectorDiagnosticsEnabled) {
      s.setNotice({ tone: "warning", message: "Connector diagnostics are not enabled in Runtime settings." });
      return;
    }
    diagnosticsBusy.current = true;
    setDiagnosticsPending(true);
    try {
      const result = await fetchIntegrationConnectionDiagnostics(connection.connectionId);
      if (!s.isCurrent()) return;
      if (
        result.connectorType !== "integration_connection" ||
        result.connectorId !== connection.connectionId ||
        !Array.isArray(result.checks) ||
        !["ok", "warn", "error"].includes(result.status) ||
        !result.checkedAt
      )
        throw new Error("The diagnostic response did not identify this connection.");
      s.setDiagnostics(result);
      s.setNotice({
        tone: result.status === "error" ? "warning" : "info",
        message: "Gateway diagnostics received. Inspect each check before using the connection.",
      });
    } catch (error) {
      if (s.isCurrent()) s.setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      diagnosticsBusy.current = false;
      setDiagnosticsPending(false);
    }
  };

  const handleOperatorAction = (action: IntegrationOperatorAction) => {
    const connection = s.selectedConnection;
    const advertised = s.selectedCatalog?.operatorActions?.find((item) => item.actionId === action.actionId);
    if (
      !s.isCurrent() ||
      !connection ||
      !hasIntegrationConnectionBinding(connection) ||
      s.review.required ||
      s.connectionMutation.locked ||
      !advertised ||
      canonicalJsonString(advertised) !== canonicalJsonString(action)
    )
      return;
    const input = action.formSchema
      ? applyIntegrationDefaults(action.formSchema, s.operatorActionInputs[action.actionId] ?? {})
      : undefined;
    const idempotencyKey = s.operatorActionIdempotencyKeys[action.actionId]?.trim();
    const generation = draftGeneration.current;
    setOperatorReview({
      connection,
      action,
      isCurrent: () => s.isCurrent() && draftGeneration.current === generation,
      input: { ...(input ? { input } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) },
    });
  };

  const confirmOperatorAction = async () => {
    const reviewed = operatorReview;
    const current = () => Boolean(reviewed?.isCurrent());
    if (!reviewed || !current()) return;
    const op = beginIntegrationMutation(reviewed.connection.connectionId);
    if (!op) return;
    const operation = {};
    visibleOperation.current = operation;
    const key = `${reviewed.connection.connectionId}:${reviewed.action.actionId}`;
    s.setOperatorBusyId(key);
    try {
      const [connection, catalog] = await Promise.all([
        fetchIntegrationConnection(reviewed.connection.connectionId),
        fetchIntegrationCatalog(),
      ]);
      if (!current()) return;
      const action = catalog.items
        .find((item) => item.catalogId === connection.catalogId)
        ?.operatorActions?.find((item) => item.actionId === reviewed.action.actionId);
      if (
        canonicalJsonString(connection) !== canonicalJsonString(reviewed.connection) ||
        !action ||
        canonicalJsonString(action) !== canonicalJsonString(reviewed.action)
      )
        throw new Error("The saved connection or advertised action changed. Refresh and review it again.");
      const result = await op.write(
        () => invokeIntegrationConnectionAction(connection.connectionId, reviewed.action.actionId, reviewed.input),
        (receipt) => {
          if (
            receipt.connectionId !== connection.connectionId ||
            receipt.catalogId !== connection.catalogId ||
            receipt.actionId !== reviewed.action.actionId ||
            !["executed", "failed", "blocked"].includes(receipt.status) ||
            !receipt.message ||
            !receipt.checkedAt
          )
            throw new Error("The Gateway did not acknowledge the reviewed integration action.");
        },
      );
      if (!current()) return;
      setOperatorReview(null);
      s.setLastOperatorActionResult({ ...result, actionLabel: reviewed.action.label });
      s.setNotice({
        tone: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "success",
        message: result.message,
      });
      // A presentation refresh cannot make an acknowledged action retryable or erase its receipt.
      try {
        await s.reload();
      } catch {
        if (current())
          s.setNotice({
            tone: "warning",
            message:
              "The action response was received, but the directory refresh failed. Its recorded result remains visible.",
          });
      }
    } catch (error) {
      if (current()) s.setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      op.finish();
      if (visibleOperation.current === operation) {
        visibleOperation.current = null;
        s.setOperatorBusyId(null);
      }
    }
  };

  return {
    handleDiagnostics,
    diagnosticsPending,
    handleOperatorAction,
    confirmOperatorAction,
    operatorReview: operatorReview?.isCurrent() ? operatorReview : null,
    operatorReviewCurrent: Boolean(operatorReview?.isCurrent()),
    cancelOperatorAction: () => setOperatorReview(null),
  };
}
