import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  type ChannelSetupHost,
} from "./channel-setup-service.js";

type DraftStore = {
  create: (input: Partial<ChannelSetupDraft> & Pick<ChannelSetupDraft, "catalogId">) => ChannelSetupDraft;
  get: (draftId: string) => ChannelSetupDraft;
  update: (draftId: string, patch: Partial<ChannelSetupDraft>) => ChannelSetupDraft;
  delete: (draftId: string) => void;
  listByCatalog: (catalogId: string, limit: number) => ChannelSetupDraft[];
  listByConnection: (connectionId: string, limit: number) => ChannelSetupDraft[];
};

function createDraftStore(): DraftStore {
  const drafts = new Map<string, ChannelSetupDraft>();
  let sequence = 0;
  return {
    create(input) {
      const now = new Date().toISOString();
      const draftId = `draft-${++sequence}`;
      const draft: ChannelSetupDraft = {
        draftId,
        catalogId: input.catalogId,
        connectionId: input.connectionId,
        lifecycleMode: input.lifecycleMode ?? "create",
        label: input.label ?? "Draft",
        enabled: input.enabled ?? true,
        draft: input.draft ?? {},
        hydration: input.hydration,
        contentVersion: input.contentVersion ?? "test-content",
        adapterVersion: input.adapterVersion ?? "test-adapter",
        validationVersion: input.validationVersion ?? "test-validation",
        testVersion: input.testVersion ?? "test-version",
        createdAt: now,
        updatedAt: now,
        lastFailureCategory: input.lastFailureCategory,
        lastValidatedAt: input.lastValidatedAt,
        lastTestedAt: input.lastTestedAt,
      };
      drafts.set(draftId, draft);
      return draft;
    },
    get(draftId) {
      const draft = drafts.get(draftId);
      if (!draft) {
        throw new Error(`Missing draft ${draftId}`);
      }
      return draft;
    },
    update(draftId, patch) {
      const current = this.get(draftId);
      const updated = {
        ...current,
        ...patch,
        draft: patch.draft ? { ...current.draft, ...patch.draft } : current.draft,
        updatedAt: new Date().toISOString(),
      };
      drafts.set(draftId, updated);
      return updated;
    },
    delete(draftId) {
      drafts.delete(draftId);
    },
    listByCatalog(catalogId, limit) {
      return [...drafts.values()].filter((item) => item.catalogId === catalogId).slice(0, limit);
    },
    listByConnection(connectionId, limit) {
      return [...drafts.values()].filter((item) => item.connectionId === connectionId).slice(0, limit);
    },
  };
}

function createHost(): ChannelSetupHost & {
  createConnectionMock: ReturnType<typeof vi.fn>;
  updateConnectionMock: ReturnType<typeof vi.fn>;
  diagnostics: ReturnType<typeof vi.fn>;
} {
  const draftStore = createDraftStore();
  const connections = new Map<string, IntegrationConnection>();
  const diagnostics = vi.fn();

  const createConnectionMock = vi.fn(
    (input: {
      catalogId: string;
      label: string;
      enabled: boolean;
      status: "connected";
      config: Record<string, unknown>;
    }) => {
      const connectionId = `connection-${connections.size + 1}`;
      const connection: IntegrationConnection = {
        connectionId,
        catalogId: input.catalogId,
        kind: "channel",
        key: input.catalogId.replace("channel.", ""),
        label: input.label,
        enabled: input.enabled,
        status: input.status,
        config: input.config,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      connections.set(connectionId, connection);
      return connection;
    },
  );

  const updateConnectionMock = vi.fn((connectionId: string, patch: Partial<IntegrationConnection>) => {
    const current = connections.get(connectionId);
    if (!current) {
      throw new Error(`Unknown connection ${connectionId}`);
    }
    const updated: IntegrationConnection = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    connections.set(connectionId, updated);
    return updated;
  });

  return {
    storage: {
      channelSetupDrafts: draftStore as ChannelSetupHost["storage"]["channelSetupDrafts"],
    },
    recentChannelSetupTests: new Map(),
    getIntegrationConnection(connectionId: string) {
      const connection = connections.get(connectionId);
      if (!connection) {
        throw new Error(`Unknown connection ${connectionId}`);
      }
      return connection;
    },
    buildIntegrationConnectionChecks: vi.fn(() => []),
    runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    createIntegrationConnection: createConnectionMock,
    updateIntegrationConnection: updateConnectionMock,
    recordDevDiagnostic: diagnostics,
    createConnectionMock,
    updateConnectionMock,
    diagnostics,
  };
}

describe("channel-setup-service contract behavior", () => {
  it("blocks live testing for invalid drafts without probing connectors", async () => {
    const host = createHost();
    const draft = await createChannelSetupDraft(host, {
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });

    const result = await testChannelSetupDraft(host, draft.draftId);

    expect(result.status).toBe("error");
    expect(result.issues.map((issue) => issue.key)).toEqual(
      expect.arrayContaining(["defaultChannelId_required", "botTokenEnv_required"]),
    );
    expect(host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
    expect(host.buildIntegrationConnectionChecks).not.toHaveBeenCalled();
  });

  it("finalizes a valid draft into a connected integration and clears draft state", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });
    host.storage.channelSetupDrafts.update(created.draftId, {
      label: "Discord Sandbox",
      draft: {
        botTokenEnv: "DISCORD_BOT_TOKEN",
        defaultChannelId: "123456789012345678",
        runtimeMode: "gateway",
      },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId);

    expect(result.validation.status).toBe("ok");
    expect(result.test?.status).toBe("ok");
    expect(host.createConnectionMock).toHaveBeenCalledTimes(1);
    expect(result.connection.connectionId).toBe("connection-1");
    expect(result.connection.status).toBe("connected");
    expect(result.connection.config).toMatchObject({
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "123456789012345678",
      runtimeMode: "gateway",
    });
    expect(() => host.storage.channelSetupDrafts.get(created.draftId)).toThrow(/Missing draft/);
    expect(host.recentChannelSetupTests.has(created.draftId)).toBe(false);
  });

  it("finalizes an outbound-only ntfy draft when its sandbox send and setup checks pass", async () => {
    const host = createHost();
    host.buildIntegrationConnectionChecks = vi.fn((connection) =>
      buildChannelCapabilityDiagnosticChecks(describeChannelCapabilities(connection.key, connection.config)),
    );
    host.runIntegrationConnectionLiveChecks = vi.fn(async () => ({
      checks: [
        {
          key: "ntfy_sandbox_send",
          status: "pass" as const,
          message: "Sandbox notification was accepted.",
        },
      ],
    }));
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.ntfy",
      lifecycleMode: "create",
    });
    host.storage.channelSetupDrafts.update(created.draftId, {
      label: "ntfy Sandbox",
      draft: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-preqa",
        dryRun: true,
      },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId);

    expect(result.validation.status).toBe("ok");
    expect(result.test).toMatchObject({ status: "ok", issues: [] });
    expect(result.connection).toMatchObject({
      key: "ntfy",
      status: "connected",
      config: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-preqa",
        dryRun: true,
      },
    });
  });

  it("reconciles public draft placeholders while leaving the internal raw update path unchanged", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.slack",
      lifecycleMode: "repair",
    });
    host.storage.channelSetupDrafts.update(created.draftId, {
      draft: {
        botToken: "bot-short",
        webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
        botTokenEnv: "SLACK_BOT_TOKEN",
        channelId: "C-OLD",
      },
      hydration: {
        status: "opaque-secret",
        fieldState: { botToken: "configured" },
        warnings: [],
        rawLegacyConfig: {
          botToken: "bot-short",
          DATABASE_PASSWORD: "db-short",
        },
      },
    });

    const updated = await updateChannelSetupDraft(
      host,
      created.draftId,
      {
        draft: {
          webhookUrl: "[REDACTED]",
          botTokenEnv: "SLACK_BOT_TOKEN_V2",
          channelId: "C-NEXT",
        },
      },
      { reconcilePublicProjection: true },
    );

    expect(updated.draft).toEqual({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
      botTokenEnv: "SLACK_BOT_TOKEN_V2",
      channelId: "C-NEXT",
    });
    expect(updated.hydration?.rawLegacyConfig).toMatchObject({
      botToken: "bot-short",
      DATABASE_PASSWORD: "db-short",
    });

    const internal = await updateChannelSetupDraft(host, created.draftId, {
      draft: {
        botToken: "replacement-short",
      },
    });
    expect(internal.draft.botToken).toBe("replacement-short");
  });
});
