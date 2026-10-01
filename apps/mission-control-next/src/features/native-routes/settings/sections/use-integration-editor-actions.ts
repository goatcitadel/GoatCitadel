import {
  createIntegrationConnection,
  deleteIntegrationConnection,
  isApiRequestError,
  type IntegrationConnection,
} from "@goatcitadel/mission-control-shared/api/client";
import { applyIntegrationDefaults } from "../helpers/channel-helpers";
import { formatJson, parseJsonObject } from "../helpers/input-format";
import { getErrorMessage } from "../SettingsShared";
import { discardSessionDraft } from "../../library/session-drafts";
import { describeIntegrationConnectionError } from "./useIntegrationConnectionReview";
import {
  beginIntegrationMutation,
  commitIntegrationConnectionUpdate,
  hasIntegrationConnectionBinding,
  integrationConflictIsUncommitted,
} from "../integration-connection-mutation";
import {
  integrationPublicConfigMatches,
  verifyIntegrationDeleted,
  verifyIntegrationReadback,
} from "./integration-editor-receipts";
import type { IntegrationSettingsState } from "./use-integration-settings-state";
export function useIntegrationEditorActions(s: IntegrationSettingsState) {
  const {
    activeWorkspaceId,
    setPanel,
    panelRef,
    mutationBusy,
    setSaving,
    applyConnection,
    setNotice,
    setSelectedConnectionId,
    review,
    connectionMutation,
    createCatalogId,
    createSchema,
    showCreateJson,
    showDetailJson,
    setDiagnostics,
    pendingDeleteConnection,
    setPendingDeleteConnection,
    setDeletePending,
    selectedConnection,
    createCanonical,
    createDraft,
    createKeyRef,
    detailDraft,
  } = s;
  const handleCreate = async (enabled = true): Promise<boolean> => {
    if (mutationBusy.current || !s.isCurrent()) return false;
    if (!createCatalogId) {
      setNotice({ tone: "warning", message: "Choose an integration catalog entry first." });
      return false;
    }
    const submitted = createDraft.value;
    const catalog = s.createableCatalog.find((item) => item.catalogId === createCatalogId);
    if (!catalog) return false;
    const op = beginIntegrationMutation(`integration-create:${createCatalogId}`);
    if (!op) return false;
    mutationBusy.current = true;
    setSaving(true);
    try {
      const input = {
        catalogId: createCatalogId,
        label: submitted.label.trim() || undefined,
        enabled,
        config: showCreateJson
          ? parseJsonObject(submitted.configText)
          : createSchema
            ? applyIntegrationDefaults(createSchema, submitted.guidedConfig)
            : submitted.guidedConfig,
      };
      const created = await op.write(
        () => createIntegrationConnection(input),
        async (receipt) => {
          if (
            !hasIntegrationConnectionBinding(receipt) ||
            receipt.catalogId !== catalog.catalogId ||
            receipt.kind !== catalog.kind ||
            receipt.key !== catalog.key ||
            receipt.enabled !== enabled ||
            (input.label && receipt.label !== input.label) ||
            !integrationPublicConfigMatches(input.config, receipt.config)
          )
            throw new Error("The created connection did not confirm the submitted configuration.");
          await verifyIntegrationReadback(receipt);
        },
      );
      const saved = createDraft.acceptSaved(createCanonical, undefined, submitted);
      if (!s.isCurrent() || createKeyRef.current !== createDraft.key) return saved;
      applyConnection(created.connectionId, created);
      setNotice({ tone: "success", message: "Connection " + created.label + " created." });
      if (saved && panelRef.current === "create") {
        setSelectedConnectionId(created.connectionId);
        setPanel("details");
      }
      return saved;
    } catch (cause) {
      if (s.isCurrent() && createKeyRef.current === createDraft.key)
        setNotice({ tone: "error", message: getErrorMessage(cause) });
      return false;
    } finally {
      op.finish();
      mutationBusy.current = false;
      setSaving(false);
    }
  };
  const handleSave = async (): Promise<boolean> => {
    if (
      mutationBusy.current ||
      connectionMutation.locked ||
      !selectedConnection ||
      detailDraft.hasRemoteChanges ||
      review.required ||
      !detailDraft.baseRevision
    )
      return false;
    const submitted = detailDraft.value;
    mutationBusy.current = true;
    setSaving(true);
    try {
      const result = await commitIntegrationConnectionUpdate({
        reviewed: selectedConnection,
        input: {
          expectedRevision: String(detailDraft.baseRevision),
          label: submitted.form.label.trim() || undefined,
          enabled: submitted.form.enabled,
          status: submitted.form.status as IntegrationConnection["status"],
          config: showDetailJson
            ? parseJsonObject(submitted.form.configText, selectedConnection.config)
            : submitted.guidedConfig,
        },
        isCurrent: () => s.isCurrent() && review.isCurrent(),
        verify: async (receipt) => {
          const config = showDetailJson
            ? parseJsonObject(submitted.form.configText, selectedConnection.config)
            : submitted.guidedConfig;
          if (!integrationPublicConfigMatches(config, receipt.config))
            throw new Error("The saved connection did not acknowledge the submitted public fields.");
          await verifyIntegrationReadback(receipt);
        },
      });
      if (result.status !== "saved") {
        if (!s.isCurrent()) return false;
        setNotice({ tone: "error", message: result.message });
        if (result.status === "conflict" || result.status === "uncertain") await review.refresh();
        return false;
      }
      const updated = result.connection;
      const saved = detailDraft.acceptSaved(
        {
          form: {
            label: updated.label,
            enabled: updated.enabled,
            status: updated.status,
            configText: formatJson(updated.config),
          },
          guidedConfig: updated.config,
        },
        updated.revision,
        submitted,
      );
      if (!s.isCurrent()) return saved;
      applyConnection(updated.connectionId, updated);
      setNotice({ tone: "success", message: "Connection updated." });
      return saved;
    } catch (cause) {
      if (!s.isCurrent()) return false;
      setNotice({ tone: "error", message: describeIntegrationConnectionError(cause) });
      if (isApiRequestError(cause) && (cause.status === 404 || cause.status === 409 || (cause.status ?? 500) >= 500))
        await review.refresh();
      return false;
    } finally {
      mutationBusy.current = false;
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (
      !pendingDeleteConnection ||
      mutationBusy.current ||
      review.required ||
      !s.isCurrent() ||
      !selectedConnection ||
      selectedConnection.connectionId !== pendingDeleteConnection.connectionId ||
      selectedConnection.revision !== pendingDeleteConnection.revision
    ) {
      return;
    }
    const op = beginIntegrationMutation(pendingDeleteConnection.connectionId);
    if (!op) return;
    mutationBusy.current = true;
    setDeletePending(true);
    try {
      await op.write(
        () => deleteIntegrationConnection(pendingDeleteConnection.connectionId, pendingDeleteConnection.revision),
        (receipt) => verifyIntegrationDeleted(pendingDeleteConnection.connectionId, receipt),
        (cause) => integrationConflictIsUncommitted(cause, pendingDeleteConnection.connectionId, "DELETE"),
      );
      discardSessionDraft("integration:" + activeWorkspaceId + ":" + pendingDeleteConnection.connectionId + ":edit");
      discardSessionDraft("integration:" + activeWorkspaceId + ":" + pendingDeleteConnection.connectionId + ":actions");
      if (!s.isCurrent()) return;
      applyConnection(pendingDeleteConnection.connectionId, null);
      setPanel(null);
      setNotice({ tone: "success", message: "Connection deleted." });
      setDiagnostics(null);
      setPendingDeleteConnection(null);
    } catch (deleteError) {
      if (!s.isCurrent()) return;
      setPendingDeleteConnection(null);
      setNotice({ tone: "error", message: describeIntegrationConnectionError(deleteError) });
      if (
        isApiRequestError(deleteError) &&
        (deleteError.status === 404 || deleteError.status === 409 || (deleteError.status ?? 500) >= 500)
      )
        await review.refresh();
    } finally {
      op.finish();
      mutationBusy.current = false;
      setDeletePending(false);
    }
  };

  s.saveActions.current = { create: handleCreate, save: handleSave };
  return { handleCreate, handleSave, handleDelete };
}
