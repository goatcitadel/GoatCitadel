import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFailureCategory,
  ChannelSetupFinalizeResult,
  ChannelSetupIssue,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  ConnectorDiagnosticReport,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import {
  buildChannelSetupValidationResult,
  buildDefaultChannelSetupDraft,
  buildEphemeralChannelConnection,
  getReusableChannelSetupTestResult,
} from "./channel-setup-helpers.js";
import {
  listChannelSetupDefinitions as listChannelSetupDefinitionCatalogs,
  requireChannelSetupDefinition,
} from "./channel-setup-definitions.js";
import {
  buildChannelSetupRecentTestSignature,
  type ChannelSetupRecentTestCacheEntry,
} from "./channel-setup-test-cache.js";
import { preserveChannelSetupDraftSecretsForPublicUpdate } from "./channel-setup-public-projection.js";

export interface ChannelSetupHost {
  readonly storage: Pick<Storage, "channelSetupDrafts">;
  readonly recentChannelSetupTests: Map<string, ChannelSetupRecentTestCacheEntry>;
  buildIntegrationConnectionChecks(connection: IntegrationConnection): ConnectorDiagnosticReport["checks"];
  createIntegrationConnection(input: {
    catalogId: string;
    label: string;
    enabled: boolean;
    status: "connected";
    config: Record<string, unknown>;
  }): Promise<IntegrationConnection>;
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  runIntegrationConnectionLiveChecks(
    connection: IntegrationConnection,
    options: { includeSandboxSend: boolean },
  ): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ConnectorDiagnosticReport["probe"] }>;
  updateIntegrationConnection(
    connectionId: string,
    patch: Partial<IntegrationConnection>,
  ): Promise<IntegrationConnection>;
}

export function getChannelSetupDefinition(_host: ChannelSetupHost, catalogId: string): ChannelSetupDefinition {
  return requireChannelSetupDefinition(catalogId).definition;
}

export function listChannelSetupDefinitions(_host: ChannelSetupHost): ChannelSetupDefinition[] {
  return listChannelSetupDefinitionCatalogs();
}

export async function listChannelSetupDrafts(
  host: ChannelSetupHost,
  options?: {
    catalogId?: string;
    connectionId?: string;
    limit?: number;
  },
): Promise<ChannelSetupDraft[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
  if (options?.connectionId) {
    return host.storage.channelSetupDrafts.listByConnection(options.connectionId, limit);
  }
  if (options?.catalogId) {
    return host.storage.channelSetupDrafts.listByCatalog(options.catalogId, limit);
  }
  const draftGroups = await Promise.all(
    listChannelSetupDefinitionCatalogs().map((definition) =>
      host.storage.channelSetupDrafts.listByCatalog(definition.catalog.catalogId, limit),
    ),
  );
  return draftGroups
    .flat()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function createChannelSetupDraft(
  host: ChannelSetupHost,
  input: ChannelSetupDraftCreateInput,
): Promise<ChannelSetupDraft> {
  const runtime = requireChannelSetupDefinition(input.catalogId);
  let seedDraft: Record<string, unknown> = buildDefaultChannelSetupDraft(runtime.definition);
  let hydration = undefined;
  let label = runtime.definition.catalog.label;
  let enabled = true;

  if (input.connectionId) {
    const connection = await host.getIntegrationConnection(input.connectionId);
    if (connection.catalogId !== input.catalogId) {
      throw new Error(`Connection ${input.connectionId} does not belong to ${input.catalogId}.`);
    }
    const hydrated = runtime.hydrate(connection);
    seedDraft = {
      ...seedDraft,
      ...hydrated.draft,
    };
    hydration = hydrated.hydration;
    label = connection.label;
    enabled = connection.enabled;
  }

  const created = await host.storage.channelSetupDrafts.create({
    ...input,
    lifecycleMode: input.lifecycleMode ?? (input.connectionId ? "edit" : "create"),
    label,
    enabled,
    draft: seedDraft,
    hydration,
    contentVersion: runtime.definition.wizard.contentVersion,
    adapterVersion: runtime.definition.adapter.adapterVersion,
    validationVersion: runtime.definition.validation.validationVersion,
    testVersion: runtime.definition.testing.testVersion,
  });

  host.recordDevDiagnostic({
    level: "info",
    category: "integrations",
    event: "channel_setup.draft.created",
    message: `Created ${created.lifecycleMode} draft for ${created.catalogId}.`,
    context: {
      draftId: created.draftId,
      catalogId: created.catalogId,
      lifecycleMode: created.lifecycleMode,
      connectionId: created.connectionId,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      contentVersion: runtime.definition.wizard.contentVersion,
      validationVersion: runtime.definition.validation.validationVersion,
      testVersion: runtime.definition.testing.testVersion,
    },
  });

  return created;
}

export async function updateChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
  input: ChannelSetupDraftUpdateInput,
  options: { reconcilePublicProjection?: boolean } = {},
): Promise<ChannelSetupDraft> {
  const current = await host.storage.channelSetupDrafts.get(draftId);
  const effectiveInput = options.reconcilePublicProjection
    ? preserveChannelSetupDraftSecretsForPublicUpdate(current, input)
    : input;
  const runtime = requireChannelSetupDefinition(current.catalogId);
  host.recentChannelSetupTests.delete(draftId);
  const updated = await host.storage.channelSetupDrafts.update(draftId, {
    ...effectiveInput,
    contentVersion: runtime.definition.wizard.contentVersion,
    adapterVersion: runtime.definition.adapter.adapterVersion,
    validationVersion: runtime.definition.validation.validationVersion,
    testVersion: runtime.definition.testing.testVersion,
  });

  host.recordDevDiagnostic({
    level: "info",
    category: "integrations",
    event: "channel_setup.draft.updated",
    message: `Updated draft ${draftId}.`,
    context: {
      catalogId: updated.catalogId,
      lifecycleMode: updated.lifecycleMode,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      contentVersion: runtime.definition.wizard.contentVersion,
      validationVersion: runtime.definition.validation.validationVersion,
      testVersion: runtime.definition.testing.testVersion,
      lastFailureCategory: updated.lastFailureCategory,
    },
  });

  return updated;
}

export async function validateChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
): Promise<ChannelSetupValidationResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const issues = runtime.validate(draft);
  const result = buildChannelSetupValidationResult(draft, runtime.definition.validation.levels, issues);
  await host.storage.channelSetupDrafts.update(draftId, {
    lastValidatedAt: result.checkedAt,
    lastFailureCategory: firstFailureCategory(result.issues),
  });
  host.recordDevDiagnostic({
    level: result.status === "error" ? "warn" : "info",
    category: "integrations",
    event: result.status === "error" ? "channel_setup.validation.failed" : "channel_setup.validation.succeeded",
    message: `Validated draft ${draftId} for ${draft.catalogId}.`,
    context: {
      draftId,
      status: result.status,
      issueCount: result.issues.length,
      catalogId: draft.catalogId,
      lifecycleMode: draft.lifecycleMode,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      validationVersion: runtime.definition.validation.validationVersion,
      failureCategory: firstFailureCategory(result.issues),
    },
  });
  return result;
}

export async function testChannelSetupDraft(host: ChannelSetupHost, draftId: string): Promise<ChannelSetupTestResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  const validation = await validateChannelSetupDraft(host, draftId);
  if (validation.status === "error") {
    host.recentChannelSetupTests.delete(draftId);
    const blocked: ChannelSetupTestResult = {
      draftId,
      status: "error",
      levels: ["structural", "semantic"],
      issues: validation.issues,
      checkedAt: new Date().toISOString(),
      recommendedNextAction: "Resolve the required setup fields before running a live test.",
    };
    await host.storage.channelSetupDrafts.update(draftId, {
      lastTestedAt: blocked.checkedAt,
      lastFailureCategory: firstFailureCategory(blocked.issues),
    });
    return blocked;
  }

  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const connection = await buildEphemeralChannelConnection(host, draft, runtime.definition.adapter.secretFieldKeys);
  const testSignature = buildChannelSetupRecentTestSignature(draft, connection, runtime.definition.testing.testVersion);
  const liveChecks = await host.runIntegrationConnectionLiveChecks(connection, { includeSandboxSend: true });
  const checks = [...host.buildIntegrationConnectionChecks(connection), ...liveChecks.checks];
  const issues = checks.flatMap((check) => mapDiagnosticCheckToChannelIssues(check));
  const status = issues.some((issue) => issue.level === "error")
    ? "error"
    : issues.some((issue) => issue.level === "warn")
      ? "warn"
      : "ok";
  const result: ChannelSetupTestResult = {
    draftId,
    status,
    levels: runtime.definition.testing.levels,
    issues,
    checkedAt: new Date().toISOString(),
    recommendedNextAction:
      status === "error"
        ? "Review the failing checks, correct the draft, then run the test again."
        : "Finalize the connection and send a sandbox message to confirm destination access.",
    probe: liveChecks.probe,
  };
  await host.storage.channelSetupDrafts.update(draftId, {
    lastTestedAt: result.checkedAt,
    lastFailureCategory: firstFailureCategory(result.issues),
  });
  if (result.status === "error") {
    host.recentChannelSetupTests.delete(draftId);
  } else {
    host.recentChannelSetupTests.set(draftId, {
      signature: testSignature,
      result,
    });
  }
  host.recordDevDiagnostic({
    level: status === "error" ? "warn" : "info",
    category: "integrations",
    event: status === "error" ? "channel_setup.test.failed" : "channel_setup.test.succeeded",
    message: `Tested draft ${draftId} for ${draft.catalogId}.`,
    context: {
      draftId,
      status,
      issueCount: issues.length,
      catalogId: draft.catalogId,
      lifecycleMode: draft.lifecycleMode,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      testVersion: runtime.definition.testing.testVersion,
      failureCategory: firstFailureCategory(result.issues),
    },
  });
  return result;
}

export async function finalizeChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
): Promise<ChannelSetupFinalizeResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const validation = await validateChannelSetupDraft(host, draftId);
  if (validation.status === "error") {
    throw new Error("Channel setup draft still has validation errors.");
  }
  const reusableTest = await getReusableChannelSetupTestResult(host, host.recentChannelSetupTests, draft);
  if (reusableTest) {
    host.recordDevDiagnostic({
      level: "info",
      category: "integrations",
      event: "channel_setup.test.reused",
      message: `Reused the most recent live test result for draft ${draftId}.`,
      context: {
        draftId,
        status: reusableTest.status,
        issueCount: reusableTest.issues.length,
        catalogId: draft.catalogId,
        lifecycleMode: draft.lifecycleMode,
        archetype: runtime.definition.wizard.archetype,
        tier: runtime.definition.telemetry.tier,
        testVersion: runtime.definition.testing.testVersion,
        checkedAt: reusableTest.checkedAt,
      },
    });
  }
  const test = reusableTest ?? (await testChannelSetupDraft(host, draftId));
  if (test.status !== "ok") {
    throw new Error(
      test.status === "warn"
        ? "Channel setup draft still has warning-level live checks. Resolve warnings before finalizing."
        : "Channel setup draft still has failing live checks.",
    );
  }

  const payload = {
    label: draft.label ?? runtime.definition.catalog.label,
    enabled: draft.enabled ?? true,
    status: "connected" as const,
    config: (await buildEphemeralChannelConnection(host, draft)).config,
    lastSyncAt: test.checkedAt,
    lastError: undefined,
  };

  const connection = draft.connectionId
    ? await host.updateIntegrationConnection(draft.connectionId, payload)
    : await host.updateIntegrationConnection(
        (
          await host.createIntegrationConnection({
            catalogId: draft.catalogId,
            label: payload.label,
            enabled: payload.enabled,
            status: payload.status,
            config: payload.config,
          })
        ).connectionId,
        {
          lastSyncAt: payload.lastSyncAt,
          lastError: payload.lastError,
        },
      );

  host.recordDevDiagnostic({
    level: "info",
    category: "integrations",
    event: "channel_setup.finalize.succeeded",
    message: `Finalized channel setup for ${draft.catalogId}.`,
    context: {
      draftId,
      connectionId: connection.connectionId,
      lifecycleMode: draft.lifecycleMode,
      catalogId: draft.catalogId,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      contentVersion: runtime.definition.wizard.contentVersion,
    },
  });

  host.recentChannelSetupTests.delete(draftId);
  await host.storage.channelSetupDrafts.delete(draftId);

  return {
    connection,
    validation,
    test,
  };
}

export async function createChannelSetupRepairDraft(
  host: ChannelSetupHost,
  connectionId: string,
): Promise<ChannelSetupDraft> {
  const connection = await host.getIntegrationConnection(connectionId);
  return createChannelSetupDraft(host, {
    catalogId: connection.catalogId,
    connectionId,
    lifecycleMode: "repair",
  });
}

export async function createChannelSetupRotateSecretDraft(
  host: ChannelSetupHost,
  connectionId: string,
): Promise<ChannelSetupDraft> {
  const connection = await host.getIntegrationConnection(connectionId);
  return createChannelSetupDraft(host, {
    catalogId: connection.catalogId,
    connectionId,
    lifecycleMode: "rotate_secret",
  });
}

export async function retestChannelConnection(
  host: ChannelSetupHost,
  connectionId: string,
): Promise<ChannelSetupTestResult> {
  const connection = await host.getIntegrationConnection(connectionId);
  const repairDraft = await createChannelSetupDraft(host, {
    catalogId: connection.catalogId,
    connectionId,
    lifecycleMode: "retest",
  });
  return testChannelSetupDraft(host, repairDraft.draftId);
}

function mapDiagnosticCheckToChannelIssues(check: ConnectorDiagnosticReport["checks"][number]): ChannelSetupIssue[] {
  if (check.status === "pass") {
    return [];
  }
  const failureCategory = inferFailureCategoryFromDiagnosticKey(check.key);
  return [
    {
      key: check.key,
      level: check.status === "fail" ? "error" : "warn",
      message: check.message,
      failureCategory,
      nextSteps: defaultNextStepsForFailureCategory(failureCategory),
    },
  ];
}

function inferFailureCategoryFromDiagnosticKey(key: string): ChannelSetupFailureCategory {
  if (key.includes("token_auth") || key === "auth_live" || key.includes("auth")) {
    return "credential_rejected";
  }
  if (key.includes("channel_access") || key.includes("sandbox_send") || key.includes("target")) {
    return "destination_mismatch";
  }
  if (key.includes("runtime")) {
    return "bridge_unavailable";
  }
  if (key.includes("cleanup")) {
    return "permission_mismatch";
  }
  if (key.includes("url")) {
    return "platform_unavailable";
  }
  return "unknown";
}

function defaultNextStepsForFailureCategory(category: ChannelSetupFailureCategory): string[] {
  switch (category) {
    case "credential_rejected":
      return ["Replace the credential, then rerun the test."];
    case "destination_mismatch":
      return ["Confirm the destination id or handle, then rerun the test."];
    case "permission_mismatch":
      return ["Confirm the bot can view and send to the destination channel, then rerun the test."];
    case "bridge_unavailable":
      return ["Restart or reconnect the runtime, then rerun the test."];
    case "platform_unavailable":
      return ["Check the remote URL or platform availability, then retry."];
    default:
      return ["Review the warning details, update the draft, and retry."];
  }
}

function firstFailureCategory(issues: ChannelSetupIssue[]): ChannelSetupFailureCategory | undefined {
  return issues.find((issue) => issue.level === "error" || issue.level === "warn")?.failureCategory;
}
