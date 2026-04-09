import { useCallback } from "react";
import {
  createIntegrationConnection,
  deleteIntegrationConnection,
  disableIntegrationPlugin,
  enableIntegrationPlugin,
  installIntegrationPlugin,
  type IntegrationConnection,
} from "../../api/client";
import { updateIntegrationConnection } from "../../api/integrations";
import { sanitizeGuidedConfig, type UiRiskLevel } from "../integrations-page-utils";

type ActionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

type UseIntegrationsMutationActionsArgs = {
  changeReviewOverall: UiRiskLevel;
  criticalConfirmed: boolean;
  selectedCatalogId: string;
  selectedCatalogIsRunnable: boolean;
  showAdvancedJson: boolean;
  configJson: string;
  guidedConfig: Record<string, unknown>;
  label: string;
  enabled: boolean;
  status: IntegrationConnection["status"];
  pluginSource: string;
  deleteTarget: IntegrationConnection | null;
  load: (options?: { background?: boolean }) => Promise<void>;
  createRun: ActionRunner;
  deleteRun: ActionRunner;
  setError: (value: string | null) => void;
  setConfigJson: (value: string) => void;
  setLabel: (value: string) => void;
  setGuidedConfig: (value: Record<string, unknown>) => void;
  setCriticalConfirmed: (value: boolean) => void;
  setPluginBusyId: (value: string | null) => void;
  setPluginSource: (value: string) => void;
  setDeleteTarget: (value: IntegrationConnection | null) => void;
};

export function useIntegrationsMutationActions({
  changeReviewOverall,
  criticalConfirmed,
  selectedCatalogId,
  selectedCatalogIsRunnable,
  showAdvancedJson,
  configJson,
  guidedConfig,
  label,
  enabled,
  status,
  pluginSource,
  deleteTarget,
  load,
  createRun,
  deleteRun,
  setError,
  setConfigJson,
  setLabel,
  setGuidedConfig,
  setCriticalConfirmed,
  setPluginBusyId,
  setPluginSource,
  setDeleteTarget,
}: UseIntegrationsMutationActionsArgs) {
  const onCreate = useCallback(async () => {
    if (changeReviewOverall === "critical" && !criticalConfirmed) {
      setError("Confirm critical integration changes before creating.");
      return;
    }
    if (!selectedCatalogId) {
      setError("Select a catalog entry first.");
      return;
    }
    if (!selectedCatalogIsRunnable) {
      setError(
        "This catalog entry is not runnable in the current runtime. Pick a runnable integration before creating a connection.",
      );
      return;
    }
    let parsedConfig: Record<string, unknown>;
    if (showAdvancedJson) {
      try {
        parsedConfig = JSON.parse(configJson) as Record<string, unknown>;
      } catch {
        setError("Connection config JSON is invalid.");
        return;
      }
    } else {
      parsedConfig = sanitizeGuidedConfig(guidedConfig);
      setConfigJson(JSON.stringify(parsedConfig, null, 2));
    }

    const derivedLabel = label.trim() || (typeof parsedConfig.label === "string" ? parsedConfig.label : "");
    const derivedEnabled = typeof parsedConfig.enabled === "boolean" ? parsedConfig.enabled : enabled;
    const { label: _omitLabel, enabled: _omitEnabled, ...normalizedConfig } = parsedConfig;

    try {
      await createRun(async () => {
        await createIntegrationConnection({
          catalogId: selectedCatalogId,
          label: derivedLabel || undefined,
          enabled: derivedEnabled,
          status,
          config: normalizedConfig,
        });
      });
      setLabel("");
      setGuidedConfig({});
      setConfigJson("{}");
      setCriticalConfirmed(false);
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [
    changeReviewOverall,
    configJson,
    createRun,
    criticalConfirmed,
    enabled,
    guidedConfig,
    label,
    load,
    selectedCatalogId,
    selectedCatalogIsRunnable,
    setConfigJson,
    setCriticalConfirmed,
    setError,
    setGuidedConfig,
    setLabel,
    showAdvancedJson,
    status,
  ]);

  const onToggle = useCallback(
    async (connection: IntegrationConnection) => {
      try {
        await updateIntegrationConnection(connection.connectionId, {
          enabled: !connection.enabled,
          status: !connection.enabled ? "connected" : "paused",
        });
        await load({ background: true });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load, setError],
  );

  const onInstallPlugin = useCallback(async () => {
    const source = pluginSource.trim();
    if (!source) {
      setError("Enter a plugin source first.");
      return;
    }
    setPluginBusyId("install");
    try {
      await installIntegrationPlugin({ source });
      setPluginSource("");
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPluginBusyId(null);
    }
  }, [load, pluginSource, setError, setPluginBusyId, setPluginSource]);

  const onTogglePlugin = useCallback(
    async (pluginId: string, currentlyEnabled: boolean) => {
      setPluginBusyId(pluginId);
      try {
        if (currentlyEnabled) {
          await disableIntegrationPlugin(pluginId);
        } else {
          await enableIntegrationPlugin(pluginId);
        }
        setError(null);
        await load({ background: true });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPluginBusyId(null);
      }
    },
    [load, setError, setPluginBusyId],
  );

  const onDeleteConfirmed = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteRun(async () => {
        await deleteIntegrationConnection(deleteTarget.connectionId);
      });
      setDeleteTarget(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deleteRun, deleteTarget, load, setDeleteTarget, setError]);

  return {
    onCreate,
    onToggle,
    onInstallPlugin,
    onTogglePlugin,
    onDeleteConfirmed,
  };
}
