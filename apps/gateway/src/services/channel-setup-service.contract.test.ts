import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupEvidenceCreateInput, IntegrationConnection } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";
import { mapProbeStepsToChecks } from "./channel-probe-result.js";
import {
  createChannelSetupDraft,
  discardChannelSetupDraft,
  finalizeChannelSetupDraft,
  reconcileChannelSetupDraftSecretCustody,
  setChannelSetupDraftSecrets,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  validateChannelSetupDraft,
  type ChannelSetupHost,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost as createHost } from "./channel-setup-service.test-support.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";

describe("channel-setup-service contract behavior", () => {
  it("rejects stale draft deletion, then removes temporary custody after exact deletion", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, { catalogId: "channel.telegram" });
    const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: created.revision,
      values: { botToken: "synthetic-delete-fixture" },
    });
    const reference = secured.secretState.botToken!.secretRef!;
    await expect(discardChannelSetupDraft(host, secured.draftId, created.revision)).rejects.toThrow();
    expect(host.channelSecrets!.resolve(reference)).toBe("synthetic-delete-fixture");
    expect(await discardChannelSetupDraft(host, secured.draftId, secured.revision)).toBe(true);
    expect(() => host.storage.channelSetupDrafts.get(secured.draftId)).toThrow();
    expect(() => host.channelSecrets!.resolve(reference)).toThrow(/unavailable/);
  });
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

  it.each(["validate", "test", "finalize"] as const)(
    "marks only the initial %s connection review conflict as before side effects",
    async (action) => {
      const host = createHost();
      const saved = host.createConnectionMock({
        catalogId: "channel.teams",
        label: "Teams",
        enabled: true,
        status: "connected",
        config: { webhookUrlEnv: "TEAMS_WORKFLOW_URL" },
      });
      const created = await createChannelSetupDraft(host, {
        catalogId: "channel.teams",
        connectionId: saved.connectionId,
      });
      await host.updateIntegrationConnection(saved.connectionId, { revision: "b".repeat(64) });
      host.updateConnectionMock.mockClear();
      const commit = vi.spyOn(host, "commitChannelSetupConnection");
      const operation =
        action === "validate"
          ? validateChannelSetupDraft(host, created.draftId, created.revision)
          : action === "test"
            ? testChannelSetupDraft(host, created.draftId, created.revision)
            : finalizeChannelSetupDraft(host, created.draftId, created.revision);

      await expect(operation).rejects.toMatchObject({
        code: "WRITE_CONFLICT",
        details: {
          reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED",
          mutationPhase: "before_side_effects",
          draftId: created.draftId,
          draftRevision: created.revision,
          connectionId: saved.connectionId,
        },
      });

      expect((await host.storage.channelSetupDrafts.get(created.draftId)).revision).toBe(created.revision);
      expect(host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
      expect(host.buildIntegrationConnectionChecks).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(host.updateConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["test", "finalize"] as const)(
    "does not mark a connection change after %s live send as safe to replay or activate",
    async (action) => {
      const host = createHost();
      const saved = host.createConnectionMock({
        catalogId: "channel.teams",
        label: "Teams",
        enabled: true,
        status: "connected",
        config: { webhookUrlEnv: "TEAMS_WORKFLOW_URL" },
      });
      const created = await createChannelSetupDraft(host, {
        catalogId: "channel.teams",
        connectionId: saved.connectionId,
      });
      const commit = vi.spyOn(host, "commitChannelSetupConnection");
      const createEvidence = vi.fn(async (input: ChannelSetupEvidenceCreateInput) => ({
        ...input,
        evidenceId: "synthetic-proof-id",
        createdAt: new Date().toISOString(),
      }));
      host.storage.channelSetupEvidence = {
        create: createEvidence,
        get: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      } as ChannelSetupHost["storage"]["channelSetupEvidence"];
      host.runIntegrationConnectionLiveChecks = vi.fn(async () => {
        // Another Settings operation advances the connection while the external send finishes.
        await host.updateIntegrationConnection(saved.connectionId, { revision: "b".repeat(64) });
        return {
          checks: [{ key: "teams_sandbox_send", status: "pass" as const, message: "Accepted." }],
          probe: {
            kind: "teams_webhook",
            mode: "webhook" as const,
            checkedAt: new Date().toISOString(),
            steps: [
              { key: "teams_sandbox_send", label: "Sandbox send", status: "pass" as const, message: "Accepted." },
            ],
          },
        };
      });
      const operation =
        action === "test"
          ? testChannelSetupDraft(host, created.draftId, created.revision)
          : finalizeChannelSetupDraft(host, created.draftId, created.revision);
      const error = await operation.catch((error: unknown) => error);

      expect(error).toMatchObject({
        code: "WRITE_CONFLICT",
        details: { reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED", connectionId: saved.connectionId },
      });
      expect(error).not.toHaveProperty("details.mutationPhase");
      expect(error).not.toHaveProperty("details.draftId");
      expect(error).not.toHaveProperty("details.draftRevision");
      expect(host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce();
      expect(host.updateConnectionMock).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(createEvidence).not.toHaveBeenCalled();
      expect(host.recentChannelSetupTests.has(created.draftId)).toBe(false);
      const retained = await host.storage.channelSetupDrafts.get(created.draftId);
      expect(retained.connectionRevision).toBe(created.connectionRevision);
      expect(retained.lastTestedAt).toBeUndefined();
    },
  );

  it("does not substitute the connection review recovery marker for a stale draft revision", async () => {
    const host = createHost();
    const saved = host.createConnectionMock({
      catalogId: "channel.teams",
      label: "Teams",
      enabled: true,
      status: "connected",
      config: { webhookUrlEnv: "TEAMS_WORKFLOW_URL" },
    });
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.teams",
      connectionId: saved.connectionId,
    });
    await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      label: "New reviewed label",
    });
    const error = await validateChannelSetupDraft(host, created.draftId, created.revision).catch(
      (error: unknown) => error,
    );

    expect(error).toMatchObject({
      code: "WRITE_CONFLICT",
      details: { reason: "CHANNEL_DRAFT_REVISION_CONFLICT", draftId: created.draftId },
    });
    expect(error).not.toHaveProperty("details.mutationPhase");
    expect(host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
  });

  it("retains Teams structural migration warnings after a successful live test and blocks activation", async () => {
    const host = createHost();
    const saved = host.createConnectionMock({
      catalogId: "channel.teams",
      label: "Legacy Teams",
      enabled: true,
      status: "connected",
      config: { webhookUrlEnv: "TEAMS_WEBHOOK_URL", cardTitle: "Ops" },
    });
    const created = await createChannelSetupDraft(host, {
      catalogId: "channel.teams",
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });
    const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: created.revision,
      values: { webhookUrl: "https://outlook.office.com/webhook/synthetic-retired-connector" },
    });
    host.runIntegrationConnectionLiveChecks = vi.fn(async () => ({
      checks: [{ key: "teams_sandbox_send", status: "pass" as const, message: "Workflow accepted the sandbox card." }],
      probe: {
        kind: "teams_webhook",
        mode: "webhook" as const,
        checkedAt: new Date().toISOString(),
        steps: [{ key: "teams_sandbox_send", label: "Sandbox send", status: "pass" as const, message: "Accepted." }],
      },
    }));

    const result = await testChannelSetupDraft(host, secured.draftId, secured.revision);

    expect(host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce();
    expect(result.status).toBe("warn");
    expect(result.issues).toEqual([
      expect.objectContaining({
        key: "teams_retired_connector",
        level: "warn",
        failureCategory: "deprecated_path",
        disposition: "blocking",
      }),
    ]);
    expect(result.finalizationEligibility).toMatchObject({
      allowed: false,
      blockingReasons: [expect.stringContaining("retired")],
    });
    await expect(finalizeChannelSetupDraft(host, secured.draftId, result.draftRevision)).rejects.toThrow(
      /connector webhooks retired/,
    );
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic-retired-connector");
  });

  it.each(["direct", "env"] as const)(
    "validates an inherited %s Teams connector URL inside custody without re-entry or public draft mutation",
    async (source) => {
      const host = createHost();
      const endpoint = "https://outlook.office.com/webhook/synthetic-inherited-connector";
      host.resolveConnectionSecret = vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) =>
        typeof config[directKey] === "string"
          ? (config[directKey] as string)
          : config[envKey] === "TEAMS_WEBHOOK_URL"
            ? endpoint
            : undefined,
      );
      const saved = host.createConnectionMock({
        catalogId: "channel.teams",
        label: "Legacy Teams",
        enabled: true,
        status: "connected",
        config: source === "direct" ? { webhookUrl: endpoint } : { webhookUrlEnv: "TEAMS_WEBHOOK_URL" },
      });
      const created = await createChannelSetupDraft(host, {
        catalogId: "channel.teams",
        connectionId: saved.connectionId,
      });
      expect(created.draft).not.toHaveProperty("webhookUrl");
      expect(created.hydration?.fieldState.webhookUrl).toBe("configured");

      const result = await validateChannelSetupDraft(host, created.draftId, created.revision);
      const stored = await host.storage.channelSetupDrafts.get(created.draftId);

      expect(host.resolveConnectionSecret).toHaveBeenCalledWith(
        expect.any(Object),
        "webhookUrl",
        "webhookUrlEnv",
        "channel.teams",
      );
      expect(result).toMatchObject({
        status: "warn",
        issues: [expect.objectContaining({ key: "teams_retired_connector", failureCategory: "deprecated_path" })],
      });
      expect(stored.draft).toEqual(created.draft);
      expect(JSON.stringify({ created, result, stored, diagnostics: host.diagnostics.mock.calls })).not.toContain(
        endpoint,
      );
      expect(host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
    },
  );

  it.each(["direct", "env"] as const)(
    "accepts an inherited %s current Teams Workflow URL without exposing its signature",
    async (source) => {
      const host = createHost();
      const endpoint =
        "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=synthetic-inherited-signature";
      host.resolveConnectionSecret = vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) =>
        typeof config[directKey] === "string"
          ? (config[directKey] as string)
          : config[envKey] === "TEAMS_WEBHOOK_URL"
            ? endpoint
            : undefined,
      );
      const saved = host.createConnectionMock({
        catalogId: "channel.teams",
        label: "Teams Workflows",
        enabled: true,
        status: "connected",
        config: source === "direct" ? { webhookUrl: endpoint } : { webhookUrlEnv: "TEAMS_WEBHOOK_URL" },
      });
      const created = await createChannelSetupDraft(host, {
        catalogId: "channel.teams",
        connectionId: saved.connectionId,
      });

      const result = await validateChannelSetupDraft(host, created.draftId, created.revision);
      const stored = await host.storage.channelSetupDrafts.get(created.draftId);

      expect(result).toMatchObject({ status: "ok", issues: [] });
      expect(stored.draft).toEqual(created.draft);
      expect(stored.draft).not.toHaveProperty("webhookUrl");
      expect(JSON.stringify({ created, result, stored, diagnostics: host.diagnostics.mock.calls })).not.toContain(
        "synthetic-inherited-signature",
      );
    },
  );

  it("blocks a retired env-backed Teams URL on create before any live send and keeps the resolved URL ephemeral", async () => {
    const host = createHost();
    const endpoint = "https://outlook.office.com/webhook/synthetic-env-connector";
    host.resolveConnectionSecret = vi.fn((config: Record<string, unknown>) =>
      config.webhookUrlEnv === "TEAMS_WEBHOOK_URL" ? endpoint : undefined,
    );
    const created = await createChannelSetupDraft(host, { catalogId: "channel.teams" });
    const configured = await updateChannelSetupDraft(host, created.draftId, {
      expectedRevision: created.revision,
      draft: { webhookUrlEnv: "TEAMS_WEBHOOK_URL" },
    });

    const result = await testChannelSetupDraft(host, configured.draftId, configured.revision);
    const stored = await host.storage.channelSetupDrafts.get(created.draftId);

    expect(result).toMatchObject({
      status: "error",
      issues: [expect.objectContaining({ key: "teams_retired_connector", level: "error" })],
      finalizationEligibility: { allowed: false },
    });
    expect(host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
    expect(stored.draft).toEqual(configured.draft);
    expect(stored.draft).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify({ configured, result, stored, diagnostics: host.diagnostics.mock.calls })).not.toContain(
      endpoint,
    );
  });

  it("keeps provider-echoed Teams callback credentials out of public issues and durable setup evidence input", async () => {
    const host = createHost();
    const signature = "synthetic+durable/callback=private";
    const endpoint =
      "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=" +
      encodeURIComponent(signature);
    const createEvidence = vi.fn(async (input: ChannelSetupEvidenceCreateInput) => ({
      ...input,
      evidenceId: "synthetic-proof-id",
      createdAt: new Date().toISOString(),
    }));
    host.storage.channelSetupEvidence = {
      create: createEvidence,
      get: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    } as ChannelSetupHost["storage"]["channelSetupEvidence"];
    host.runIntegrationConnectionLiveChecks = vi.fn(
      async (
        connection: IntegrationConnection,
        options: Parameters<ChannelSetupHost["runIntegrationConnectionLiveChecks"]>[1],
      ) =>
        runWebhookDestinationLiveChecks({
          channelKey: "teams",
          webhookUrl: String(connection.config.webhookUrl),
          includeSandboxSend: options.includeSandboxSend,
          fetcher: vi.fn(
            async () =>
              new Response(
                JSON.stringify({ message: "Workflow permission denied: " + endpoint + " decoded " + signature }),
                { status: 403 },
              ),
          ),
        }),
    );
    const created = await createChannelSetupDraft(host, { catalogId: "channel.teams" });
    const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: created.revision,
      values: { webhookUrl: endpoint },
    });

    const result = await testChannelSetupDraft(host, secured.draftId, secured.revision);

    expect(result).toMatchObject({
      status: "error",
      evidenceId: "synthetic-proof-id",
      finalizationEligibility: { allowed: false },
    });
    expect(result.issues[0]?.message).toContain("HTTP 403");
    expect(result.probe?.steps[0]).toMatchObject({ status: "fail", failureCategory: "permission_mismatch" });
    expect(createEvidence).toHaveBeenCalledOnce();
    const publicAndDurable = JSON.stringify({
      result,
      evidenceInput: createEvidence.mock.calls,
      diagnostics: host.diagnostics.mock.calls,
    });
    expect(publicAndDurable).not.toContain(endpoint);
    expect(publicAndDurable).not.toContain(signature);
    expect(publicAndDurable).not.toContain(encodeURIComponent(signature));
    expect(publicAndDurable).toContain("[REDACTED]");
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
    expect(result.connection.connectionId).toMatch(/^[a-f0-9-]{36}$/);
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
    expect(result.connection.connectionId).toMatch(/^[a-f0-9-]{36}$/);
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

  it.each([
    {
      when: "a message was sent and is still there",
      steps: [{ key: "ntfy_sandbox_send", status: "pass" }],
      status: "ok",
      nextAction: "Check that the test message arrived, then finalize.",
    },
    {
      when: "the message was sent and then deleted",
      steps: [
        { key: "ntfy_sandbox_send", status: "pass" },
        { key: "ntfy_sandbox_cleanup", status: "pass" },
      ],
      status: "ok",
      nextAction:
        "The test message was sent and then deleted, so there's nothing to look for. Finalize when you're ready.",
    },
    {
      when: "the message was sent but not deleted",
      steps: [
        { key: "ntfy_sandbox_send", status: "pass" },
        { key: "ntfy_sandbox_cleanup", status: "warn" },
      ],
      status: "warn",
      nextAction: "Check that the test message arrived, then finalize.",
    },
    {
      when: "a dry run sent nothing",
      steps: [{ key: "ntfy_sandbox_send", status: "skipped" }],
      status: "ok",
      nextAction: "No test message was sent. Finalize when you're ready.",
    },
    {
      when: "the send failed",
      steps: [{ key: "ntfy_sandbox_send", status: "fail" }],
      status: "error",
      nextAction: "Review the failing checks, correct the draft, then run the test again.",
    },
  ] as const)("words the next step after a live test where $when", async ({ steps, status, nextAction }) => {
    const host = createHost();
    host.buildIntegrationConnectionChecks = vi.fn(() => []);
    const probeSteps = steps.map((step) => ({ ...step, label: step.key, message: "Sandbox notification result." }));
    host.runIntegrationConnectionLiveChecks = vi.fn(async () => ({
      checks: mapProbeStepsToChecks(probeSteps),
      probe: { kind: "ntfy", checkedAt: "2026-10-28T00:00:00.000Z", steps: probeSteps },
    }));
    const created = await createChannelSetupDraft(host, { catalogId: "channel.ntfy", lifecycleMode: "create" });
    const configured = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: { baseUrl: "https://ntfy.sh", topic: "goatcitadel-preqa", dryRun: true },
    });

    const result = await testChannelSetupDraft(host, configured.draftId, configured.revision);

    expect(result.status).toBe(status);
    expect(result.recommendedNextAction).toBe(nextAction);
  });

  it("protects server-adopted OAuth metadata on the actual public update path", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, { catalogId: "channel.slack" });
    await expect(
      updateChannelSetupDraft(
        host,
        created.draftId,
        { expectedRevision: created.revision, draft: { slackInstallId: "forged-install", slackTeamId: "forged-team" } },
        { reconcilePublicProjection: true },
      ),
    ).rejects.toThrow("explicitly adopt");
    const adopted = await host.storage.channelSetupDrafts.update(created.draftId, {
      expectedRevision: created.revision,
      draft: {
        ...created.draft,
        authMode: "oauth",
        slackInstallId: "server-install",
        slackTeamId: "server-team",
        slackScopes: ["chat:write"],
      },
    });
    const updated = await updateChannelSetupDraft(
      host,
      created.draftId,
      {
        expectedRevision: adopted.revision,
        draft: { targets: [{ label: "Sandbox", channel: "C123", default: true }] },
      },
      { reconcilePublicProjection: true },
    );
    expect(updated.draft).toMatchObject({
      authMode: "oauth",
      slackInstallId: "server-install",
      slackTeamId: "server-team",
      slackScopes: ["chat:write"],
    });
    await expect(
      updateChannelSetupDraft(host, created.draftId, {
        expectedRevision: updated.revision,
        draft: { ...updated.draft, slackTeamId: "replaced-team" },
      }),
    ).rejects.toThrow("explicitly adopt");
  });

  it("reports a committed discard when temporary credential cleanup fails", async () => {
    const host = createHost();
    const draft = await createChannelSetupDraft(host, { catalogId: "channel.telegram" });
    const secured = await setChannelSetupDraftSecrets(host, draft.draftId, {
      expectedRevision: draft.revision,
      values: { botToken: "test-token" },
    });
    host.channelSecrets!.deleteTemporary = vi.fn(() => {
      throw new Error("Keychain unavailable");
    });
    await expect(discardChannelSetupDraft(host, secured.draftId, secured.revision)).rejects.toMatchObject({
      mutationCommitted: true,
    });
    expect(() => host.storage.channelSetupDrafts.get(secured.draftId)).toThrow("Missing draft");
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

  it("keeps an inline Google Chat service-account key in secure custody through finalize", async () => {
    const host = createHost();
    const inlineKey = JSON.stringify({
      client_email: "bot@example.iam.gserviceaccount.com",
      private_key: "synthetic-pk",
    });
    const created = await createChannelSetupDraft(host, { catalogId: "channel.google-chat", lifecycleMode: "create" });
    const configured = await updateChannelSetupDraft(host, created.draftId, {
      expectedRevision: created.revision,
      label: "Google Chat app",
      draft: {
        audienceType: "project_number",
        audience: "123456789012",
        defaultSpace: "spaces/AAAA",
        allowedSenders: ["users/1"],
      },
    });
    await expect(
      updateChannelSetupDraft(host, created.draftId, {
        expectedRevision: configured.revision,
        draft: { ...configured.draft, serviceAccountKey: inlineKey },
      }),
    ).rejects.toThrow(/dedicated secure-input endpoint/);
    expect(JSON.stringify(host.storage.channelSetupDrafts.get(created.draftId))).not.toContain("synthetic-pk");

    const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: configured.revision,
      values: { serviceAccountKey: inlineKey },
    });
    expect(secured.draft).not.toHaveProperty("serviceAccountKey");
    expect(JSON.stringify(secured)).not.toContain("synthetic-pk");
    expect(secured.secretState.serviceAccountKey).toMatchObject({ configured: true, custody: "temporary" });

    const result = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);
    const persistedRef = result.connection.config.serviceAccountKey;
    expect(persistedRef).toEqual(expect.stringMatching(/^keychain:goatcitadel:channel-connection:/));
    expect(host.channelSecrets?.resolve(persistedRef as string)).toBe(inlineKey);
    expect(JSON.stringify(result.connection.config)).not.toContain("synthetic-pk");
    expect(result.connection.config).toMatchObject({
      audienceType: "project_number",
      audience: "123456789012",
      defaultSpace: "spaces/AAAA",
      inboundAccessMode: "allowlist",
    });
  });
});
