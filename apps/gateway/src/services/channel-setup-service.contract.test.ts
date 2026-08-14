import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  reconcileChannelSetupDraftSecretCustody,
  setChannelSetupDraftSecrets,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  type ChannelSetupHost,
} from "./channel-setup-service.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";

type DraftStore = {
  create: (input: Partial<ChannelSetupDraft> & Pick<ChannelSetupDraft, "catalogId">) => ChannelSetupDraft;
  get: (draftId: string) => ChannelSetupDraft;
  update: (draftId: string, patch: Partial<ChannelSetupDraft> & { expectedRevision: number }) => ChannelSetupDraft;
  delete: (draftId: string, expectedRevision?: number) => void;
  listByCatalog: (catalogId: string, limit: number) => ChannelSetupDraft[];
  listByConnection: (connectionId: string, limit: number) => ChannelSetupDraft[];
};

function createDraftStore(): DraftStore {
  const drafts = new Map<string, ChannelSetupDraft>();
  let sequence = 0;
  return {
    create(input) {
      const now = new Date().toISOString();
      const draftId = input.draftId ?? `draft-${++sequence}`;
      const draft: ChannelSetupDraft = {
        draftId,
        revision: 1,
        catalogId: input.catalogId,
        connectionId: input.connectionId,
        lifecycleMode: input.lifecycleMode ?? "create",
        label: input.label ?? "Draft",
        enabled: input.enabled ?? true,
        draft: input.draft ?? {},
        secretState: input.secretState ?? {},
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
      if (patch.expectedRevision !== current.revision) throw new Error("stale draft");
      const updated = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        draft: patch.draft ? { ...patch.draft } : current.draft,
        secretState: patch.secretState ? { ...patch.secretState } : current.secretState,
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
  const secretValues = new Map<string, string>();
  const channelSecrets = new ChannelSecretCustodyService({
    setSecret: (account, value) => void secretValues.set(account, value),
    getSecret: (account) => secretValues.get(account),
    deleteSecret: (account) => void secretValues.delete(account),
  } as never);

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
    channelSecrets,
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
  it("moves legacy raw draft credentials into keychain custody and scrubs legacy hydration", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, { catalogId: "channel.discord" });
    await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: { ...created.draft, botToken: "legacy-top-secret" },
      hydration: {
        status: "legacy-shape",
        fieldState: { botToken: "configured" },
        warnings: [],
        rawLegacyConfig: { botToken: "legacy-top-secret" },
      },
    });

    const result = await reconcileChannelSetupDraftSecretCustody(host);
    const reconciled = await host.storage.channelSetupDrafts.get(created.draftId);

    expect(result, JSON.stringify(host.diagnostics.mock.calls)).toMatchObject({
      scanned: 1,
      migrated: 1,
      invalidated: 0,
      scrubbed: 1,
    });
    expect(reconciled.draft).not.toHaveProperty("botToken");
    expect(reconciled.hydration).not.toHaveProperty("rawLegacyConfig");
    expect(reconciled.secretState.botToken).toMatchObject({ configured: true, custody: "temporary" });
    expect(host.channelSecrets?.resolve(reconciled.secretState.botToken?.secretRef ?? "")).toBe("legacy-top-secret");
  });

  it("scrubs and invalidates legacy credentials when secure custody is unavailable", async () => {
    const host = createHost();
    delete host.channelSecrets;
    const created = await createChannelSetupDraft(host, { catalogId: "channel.discord" });
    await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: { ...created.draft, botToken: "must-not-survive" },
    });

    const result = await reconcileChannelSetupDraftSecretCustody(host);
    const reconciled = await host.storage.channelSetupDrafts.get(created.draftId);

    expect(result).toMatchObject({ scanned: 1, migrated: 0, invalidated: 1, scrubbed: 1 });
    expect(reconciled.draft).not.toHaveProperty("botToken");
    expect(reconciled.secretState.botToken).toEqual({ configured: false, custody: "temporary" });
    expect(reconciled.hydration?.status).toBe("invalid-runtime");
    expect(reconciled.lastFailureCategory).toBe("credential_rejected");
  });

  it("blocks live testing for invalid drafts without probing connectors", async () => {
    const host = createHost();
    const draft = await createChannelSetupDraft(host, {
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });

    const result = await testChannelSetupDraft(host, draft.draftId, draft.revision);

    expect(result.status).toBe("error");
    expect(result.issues.map((issue) => issue.key)).toEqual(
      expect.arrayContaining(["defaultChannelId_required", "defaultGuildId_required", "botTokenEnv_required"]),
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
    const configured = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      label: "Discord Sandbox",
      draft: {
        botTokenEnv: "DISCORD_BOT_TOKEN",
        defaultChannelId: "123456789012345678",
        defaultGuildId: "987654321098765432",
        runtimeMode: "gateway",
      },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId, configured.revision);

    expect(result.validation.status).toBe("ok");
    expect(result.test?.status).toBe("ok");
    expect(host.createConnectionMock).toHaveBeenCalledTimes(1);
    expect(result.connection.connectionId).toBe("connection-1");
    expect(result.connection.status).toBe("connected");
    expect(result.connection.config).toMatchObject({
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "123456789012345678",
      defaultGuildId: "987654321098765432",
      runtimeMode: "gateway",
    });
    expect(() => host.storage.channelSetupDrafts.get(created.draftId)).toThrow(/Missing draft/);
    expect(host.recentChannelSetupTests.has(created.draftId)).toBe(false);
  });

  it("defers Discord runtime readiness until a new gateway draft has a durable connection", async () => {
    const host = createHost();
    host.runIntegrationConnectionLiveChecks = vi.fn(async (_connection, options) => ({
      checks:
        options.discordRuntimeReadiness === "deferred"
          ? []
          : [
              {
                key: "discord_runtime_ready",
                status: "fail" as const,
                message: "Gateway runtime is not configured for this connection yet.",
              },
            ],
    }));
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });
    const configured = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: {
        botTokenEnv: "DISCORD_BOT_TOKEN",
        defaultChannelId: "123456789012345678",
        defaultGuildId: "987654321098765432",
        runtimeMode: "gateway",
      },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId, configured.revision);

    expect(host.runIntegrationConnectionLiveChecks).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: created.draftId, key: "discord" }),
      {
        includeSandboxSend: true,
        discordRuntimeReadiness: "deferred",
      },
    );
    expect(result.test.status).toBe("ok");
    expect(result.connection.connectionId).toBe("connection-1");
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
    const configured = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      label: "ntfy Sandbox",
      draft: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-preqa",
        dryRun: true,
      },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId, configured.revision);

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

  it("keeps channel credentials in secure custody and rejects generic secret writes", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.slack",
      lifecycleMode: "repair",
    });
    const seeded = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: {
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
    const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: seeded.revision,
      values: {
        botToken: "bot-short",
        webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
      },
    });

    const updated = await updateChannelSetupDraft(
      host,
      created.draftId,
      {
        expectedRevision: secured.revision,
        draft: {
          webhookUrl: "[REDACTED]",
          botTokenEnv: "SLACK_BOT_TOKEN_V2",
          channelId: "C-NEXT",
        },
      },
      { reconcilePublicProjection: true },
    );

    expect(updated.draft).toEqual({
      botTokenEnv: "SLACK_BOT_TOKEN_V2",
      channelId: "C-NEXT",
    });
    expect(updated.secretState).toMatchObject({
      botToken: { configured: true, custody: "temporary" },
      webhookUrl: { configured: true, custody: "temporary" },
    });
    expect(updated.hydration?.rawLegacyConfig).toMatchObject({
      botToken: "bot-short",
      DATABASE_PASSWORD: "db-short",
    });

    await expect(
      updateChannelSetupDraft(host, created.draftId, {
        expectedRevision: updated.revision,
        draft: { botToken: "replacement-short" },
      }),
    ).rejects.toThrow(/dedicated secure-input endpoint/);
    const replaced = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: updated.revision,
      values: { botToken: "replacement-short" },
    });
    const replacementRef = replaced.secretState.botToken?.secretRef;
    expect(replacementRef).toEqual(expect.any(String));
    expect(replacementRef).not.toContain("replacement-short");
    expect(host.channelSecrets?.resolve(replacementRef!)).toBe("replacement-short");
  });
});
