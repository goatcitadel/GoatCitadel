import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "../../api/client";
import { useIntegrationsMutationActions } from "./useIntegrationsMutationActions";

const apiMocks = vi.hoisted(() => ({
  createIntegrationConnection: vi.fn(async () => ({})),
  deleteIntegrationConnection: vi.fn(async () => ({})),
  disableIntegrationPlugin: vi.fn(async () => ({})),
  enableIntegrationPlugin: vi.fn(async () => ({})),
  installIntegrationPlugin: vi.fn(async () => ({})),
  updateIntegrationConnection: vi.fn(async () => ({})),
}));

vi.mock("../../api/client", () => ({
  createIntegrationConnection: apiMocks.createIntegrationConnection,
  deleteIntegrationConnection: apiMocks.deleteIntegrationConnection,
  disableIntegrationPlugin: apiMocks.disableIntegrationPlugin,
  enableIntegrationPlugin: apiMocks.enableIntegrationPlugin,
  installIntegrationPlugin: apiMocks.installIntegrationPlugin,
}));

vi.mock("../../api/integrations", () => ({
  updateIntegrationConnection: apiMocks.updateIntegrationConnection,
}));

type Actions = ReturnType<typeof useIntegrationsMutationActions>;

let latestActions: Actions | null = null;
let latestState: {
  error: string | null;
  configJson: string;
  label: string;
  guidedConfig: Record<string, unknown>;
  criticalConfirmed: boolean;
  pluginBusyId: string | null;
  pluginSource: string;
  deleteTarget: IntegrationConnection | null;
  loadCalls: Array<{ background?: boolean } | undefined>;
} | null = null;

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: "discord",
    label: "Discord",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:00.000Z",
    ...overrides,
  } as IntegrationConnection;
}

function Harness(props: {
  changeReviewOverall?: "safe" | "warning" | "critical";
  criticalConfirmed?: boolean;
  selectedCatalogId?: string;
  selectedCatalogIsRunnable?: boolean;
  showAdvancedJson?: boolean;
  configJson?: string;
  guidedConfig?: Record<string, unknown>;
  label?: string;
  enabled?: boolean;
  status?: IntegrationConnection["status"];
  pluginSource?: string;
  deleteTarget?: IntegrationConnection | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [configJson, setConfigJson] = useState(props.configJson ?? "{}");
  const [label, setLabel] = useState(props.label ?? "");
  const [guidedConfig, setGuidedConfig] = useState<Record<string, unknown>>(props.guidedConfig ?? {});
  const [criticalConfirmed, setCriticalConfirmed] = useState(props.criticalConfirmed ?? false);
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null);
  const [pluginSource, setPluginSource] = useState(props.pluginSource ?? "");
  const [deleteTarget, setDeleteTarget] = useState<IntegrationConnection | null>(props.deleteTarget ?? null);
  const [loadCalls, setLoadCalls] = useState<Array<{ background?: boolean } | undefined>>([]);

  const load = async (options?: { background?: boolean }) => {
    setLoadCalls((current) => [...current, options]);
  };

  latestActions = useIntegrationsMutationActions({
    changeReviewOverall: props.changeReviewOverall ?? "safe",
    criticalConfirmed,
    selectedCatalogId: props.selectedCatalogId ?? "discord",
    selectedCatalogIsRunnable: props.selectedCatalogIsRunnable ?? true,
    showAdvancedJson: props.showAdvancedJson ?? false,
    configJson,
    guidedConfig,
    label,
    enabled: props.enabled ?? true,
    status: props.status ?? "connected",
    pluginSource,
    deleteTarget,
    load,
    createRun: async (operation) => operation(),
    deleteRun: async (operation) => operation(),
    setError,
    setConfigJson,
    setLabel,
    setGuidedConfig,
    setCriticalConfirmed,
    setPluginBusyId,
    setPluginSource,
    setDeleteTarget,
  });

  latestState = {
    error,
    configJson,
    label,
    guidedConfig,
    criticalConfirmed,
    pluginBusyId,
    pluginSource,
    deleteTarget,
    loadCalls,
  };

  return null;
}

describe("useIntegrationsMutationActions", () => {
  beforeEach(() => {
    latestActions = null;
    latestState = null;
    for (const mock of Object.values(apiMocks)) {
      mock.mockClear();
    }
  });

  it("blocks unsafe or invalid creates before calling the gateway", async () => {
    await act(async () => {
      create(<Harness changeReviewOverall="critical" criticalConfirmed={false} />);
    });
    await act(async () => {
      await latestActions?.onCreate();
    });
    expect(latestState?.error).toBe("Confirm critical integration changes before creating.");
    expect(apiMocks.createIntegrationConnection).not.toHaveBeenCalled();

    await act(async () => {
      create(<Harness selectedCatalogId="" />);
    });
    await act(async () => {
      await latestActions?.onCreate();
    });
    expect(latestState?.error).toBe("Select a catalog entry first.");

    await act(async () => {
      create(<Harness selectedCatalogIsRunnable={false} />);
    });
    await act(async () => {
      await latestActions?.onCreate();
    });
    expect(latestState?.error).toContain("not runnable");

    await act(async () => {
      create(<Harness showAdvancedJson configJson="{bad json" />);
    });
    await act(async () => {
      await latestActions?.onCreate();
    });
    expect(latestState?.error).toBe("Connection config JSON is invalid.");
  });

  it("normalizes guided config, creates connections, and resets form state", async () => {
    await act(async () => {
      create(
        <Harness
          guidedConfig={{ label: "Config Label", enabled: false, token: "abc", blank: "", retries: 2 }}
          label=" Manual Label "
          enabled
          status="connected"
        />,
      );
    });

    await act(async () => {
      await latestActions?.onCreate();
    });

    expect(apiMocks.createIntegrationConnection).toHaveBeenCalledWith({
      catalogId: "discord",
      label: "Manual Label",
      enabled: false,
      status: "connected",
      config: { token: "abc", retries: 2 },
    });
    expect(latestState).toMatchObject({
      error: null,
      configJson: "{}",
      label: "",
      guidedConfig: {},
      criticalConfirmed: false,
      loadCalls: [{ background: true }],
    });
  });

  it("toggles connections, manages plugins, and deletes confirmed targets", async () => {
    await act(async () => {
      create(<Harness pluginSource="  npm:@goat/plugin  " deleteTarget={connection()} />);
    });

    await act(async () => {
      await latestActions?.onToggle(connection({ enabled: true }));
      await latestActions?.onInstallPlugin();
      await latestActions?.onTogglePlugin("plugin-1", true);
      await latestActions?.onTogglePlugin("plugin-2", false);
      await latestActions?.onDeleteConfirmed();
    });

    expect(apiMocks.updateIntegrationConnection).toHaveBeenCalledWith("conn-1", {
      enabled: false,
      status: "paused",
    });
    expect(apiMocks.installIntegrationPlugin).toHaveBeenCalledWith({ source: "npm:@goat/plugin" });
    expect(apiMocks.disableIntegrationPlugin).toHaveBeenCalledWith("plugin-1");
    expect(apiMocks.enableIntegrationPlugin).toHaveBeenCalledWith("plugin-2");
    expect(apiMocks.deleteIntegrationConnection).toHaveBeenCalledWith("conn-1");
    expect(latestState?.pluginSource).toBe("");
    expect(latestState?.pluginBusyId).toBeNull();
    expect(latestState?.deleteTarget).toBeNull();
    expect(latestState?.loadCalls).toHaveLength(5);
  });

  it("requires a plugin source before installation", async () => {
    await act(async () => {
      create(<Harness pluginSource=" " />);
    });

    await act(async () => {
      await latestActions?.onInstallPlugin();
    });

    expect(latestState?.error).toBe("Enter a plugin source first.");
    expect(apiMocks.installIntegrationPlugin).not.toHaveBeenCalled();
  });
});
