import { randomUUID } from "node:crypto";
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
import { SECRET_REDACTION_MARKER, ValidationError } from "@goatcitadel/contracts";
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
import type { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";

export interface ChannelSetupHost {
  readonly storage: Pick<Storage, "channelSetupDrafts">;
  readonly recentChannelSetupTests: Map<string, ChannelSetupRecentTestCacheEntry>;
  readonly channelSecrets?: Pick<
    ChannelSecretCustodyService,
    | "storeTemporary"
    | "resolve"
    | "copyToConnection"
    | "deleteTemporary"
    | "delete"
    | "isChannelSecretRef"
    | "custodyFor"
    | "assertUsableForDraft"
  >;
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
    options: {
      includeSandboxSend: boolean;
      discordRuntimeReadiness?: "required" | "deferred";
    },
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
  const draftId = randomUUID();
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

  const secured = custodyInitialDraftSecrets(host, draftId, seedDraft, runtime.definition.adapter.secretFieldKeys);
  hydration = sanitizeChannelSetupHydration(hydration);

  let created: ChannelSetupDraft;
  try {
    created = await host.storage.channelSetupDrafts.create({
      ...input,
      draftId,
      lifecycleMode: input.lifecycleMode ?? (input.connectionId ? "edit" : "create"),
      label,
      enabled,
      draft: secured.draft,
      secretState: secured.secretState,
      hydration,
      contentVersion: runtime.definition.wizard.contentVersion,
      adapterVersion: runtime.definition.adapter.adapterVersion,
      validationVersion: runtime.definition.validation.validationVersion,
      testVersion: runtime.definition.testing.testVersion,
    });
  } catch (error) {
    for (const state of Object.values(secured.secretState)) {
      if (state.secretRef && state.custody === "temporary") host.channelSecrets?.deleteTemporary(state.secretRef);
    }
    throw error;
  }

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
  assertDraftRevision(current, input.expectedRevision);
  const effectiveInput = options.reconcilePublicProjection
    ? preserveChannelSetupDraftSecretsForPublicUpdate(current, input)
    : input;
  const runtime = requireChannelSetupDefinition(current.catalogId);
  const publicDraft = effectiveInput.draft
    ? stripGenericSecretFields(effectiveInput.draft, runtime.definition.adapter.secretFieldKeys)
    : undefined;
  host.recentChannelSetupTests.delete(draftId);
  const updated = await host.storage.channelSetupDrafts.update(draftId, {
    ...effectiveInput,
    expectedRevision: current.revision,
    ...(publicDraft ? { draft: publicDraft } : {}),
    secretState: current.secretState ?? {},
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
  expectedRevision: number,
): Promise<ChannelSetupValidationResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(draft, expectedRevision);
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const issues = runtime.validate(hydrateChannelSetupDraftSecrets(host, draft));
  const result = buildChannelSetupValidationResult(draft, runtime.definition.validation.levels, issues);
  const updated = await host.storage.channelSetupDrafts.update(draftId, {
    expectedRevision: draft.revision,
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
  return { ...result, draftRevision: updated.revision };
}

export async function testChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupTestResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(draft, expectedRevision);
  const validation = await validateChannelSetupDraft(host, draftId, draft.revision);
  const validatedDraft = await host.storage.channelSetupDrafts.get(draftId);
  if (validation.status === "error") {
    host.recentChannelSetupTests.delete(draftId);
    const blocked: ChannelSetupTestResult = {
      draftId,
      draftRevision: validatedDraft.revision,
      status: "error",
      levels: ["structural", "semantic"],
      issues: validation.issues,
      checkedAt: new Date().toISOString(),
      recommendedNextAction: "Resolve the required setup fields before running a live test.",
    };
    const updated = await host.storage.channelSetupDrafts.update(draftId, {
      expectedRevision: validatedDraft.revision,
      lastTestedAt: blocked.checkedAt,
      lastFailureCategory: firstFailureCategory(blocked.issues),
    });
    return { ...blocked, draftRevision: updated.revision };
  }

  const runtime = requireChannelSetupDefinition(validatedDraft.catalogId);
  const hydratedDraft = hydrateChannelSetupDraftSecrets(host, validatedDraft);
  const connection = await buildEphemeralChannelConnection(
    host,
    hydratedDraft,
    runtime.definition.adapter.secretFieldKeys,
  );
  const testSignature = buildChannelSetupRecentTestSignature(
    validatedDraft,
    connection,
    runtime.definition.testing.testVersion,
  );
  const liveChecks = await host.runIntegrationConnectionLiveChecks(connection, {
    includeSandboxSend: true,
    ...(draft.catalogId === "channel.discord" && !draft.connectionId
      ? { discordRuntimeReadiness: "deferred" as const }
      : {}),
  });
  const checks = [...host.buildIntegrationConnectionChecks(connection), ...liveChecks.checks];
  const issues = checks.flatMap((check) => mapDiagnosticCheckToChannelIssues(check));
  const status = issues.some((issue) => issue.level === "error")
    ? "error"
    : issues.some((issue) => issue.level === "warn")
      ? "warn"
      : "ok";
  const result: ChannelSetupTestResult = {
    draftId,
    draftRevision: validatedDraft.revision,
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
  const updated = await host.storage.channelSetupDrafts.update(draftId, {
    expectedRevision: validatedDraft.revision,
    lastTestedAt: result.checkedAt,
    lastFailureCategory: firstFailureCategory(result.issues),
  });
  const finalResult = { ...result, draftRevision: updated.revision };
  if (result.status === "error") {
    host.recentChannelSetupTests.delete(draftId);
  } else {
    host.recentChannelSetupTests.set(draftId, {
      signature: testSignature,
      result: finalResult,
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
  return finalResult;
}

export async function finalizeChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupFinalizeResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(draft, expectedRevision);
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const validation = await validateChannelSetupDraft(host, draftId, draft.revision);
  if (validation.status === "error") {
    throw new Error("Channel setup draft still has validation errors.");
  }
  const validatedDraft = await host.storage.channelSetupDrafts.get(draftId);
  const reusableTest = await getReusableChannelSetupTestResult(host, host.recentChannelSetupTests, validatedDraft);
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
  const test = reusableTest ?? (await testChannelSetupDraft(host, draftId, validatedDraft.revision));
  if (test.status !== "ok") {
    throw new Error(
      test.status === "warn"
        ? "Channel setup draft still has warning-level live checks. Resolve warnings before finalizing."
        : "Channel setup draft still has failing live checks.",
    );
  }

  const readyDraft = await host.storage.channelSetupDrafts.get(draftId);
  if (readyDraft.revision !== test.draftRevision) {
    throw new Error("Channel setup draft changed after its live test; run the test again before finalizing.");
  }
  const payload = {
    label: readyDraft.label ?? runtime.definition.catalog.label,
    enabled: readyDraft.enabled ?? true,
    status: "connected" as const,
    config: (await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, readyDraft))).config,
    lastSyncAt: test.checkedAt,
    lastError: undefined,
  };

  const connection = await persistConnectionWithSecretReferences(host, readyDraft, payload);

  host.recordDevDiagnostic({
    level: "info",
    category: "integrations",
    event: "channel_setup.finalize.succeeded",
    message: `Finalized channel setup for ${draft.catalogId}.`,
    context: {
      draftId,
      connectionId: connection.connectionId,
      lifecycleMode: readyDraft.lifecycleMode,
      catalogId: readyDraft.catalogId,
      archetype: runtime.definition.wizard.archetype,
      tier: runtime.definition.telemetry.tier,
      contentVersion: runtime.definition.wizard.contentVersion,
    },
  });

  host.recentChannelSetupTests.delete(draftId);
  await host.storage.channelSetupDrafts.delete(draftId, readyDraft.revision);

  return {
    draftRevision: readyDraft.revision,
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

export async function setChannelSetupDraftSecrets(
  host: ChannelSetupHost,
  draftId: string,
  input: { expectedRevision: number; values: Readonly<Record<string, string>> },
): Promise<ChannelSetupDraft> {
  const current = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(current, input.expectedRevision);
  const custody = requireChannelSecretCustody(host);
  const runtime = requireChannelSetupDefinition(current.catalogId);
  const allowed = new Set(runtime.definition.adapter.secretFieldKeys);
  const entries = Object.entries(input.values);
  if (entries.length === 0) throw new ValidationError({ message: "At least one channel credential is required." });
  for (const [fieldKey] of entries) {
    if (!allowed.has(fieldKey)) {
      throw new ValidationError({
        message: `Channel credential field ${fieldKey} is not allowlisted for ${current.catalogId}.`,
      });
    }
  }

  const staged: Array<{ fieldKey: string; secretRef: string }> = [];
  try {
    for (const [fieldKey, secret] of entries) {
      staged.push({ fieldKey, secretRef: custody.storeTemporary(draftId, fieldKey, secret) });
    }
    const secretState = { ...(current.secretState ?? {}) };
    for (const item of staged) {
      secretState[item.fieldKey] = { configured: true, custody: "temporary", secretRef: item.secretRef };
    }
    const updated = await host.storage.channelSetupDrafts.update(draftId, {
      expectedRevision: current.revision,
      draft: omitSecretFields(current.draft, runtime.definition.adapter.secretFieldKeys),
      secretState,
    });
    for (const item of staged) {
      const prior = current.secretState?.[item.fieldKey];
      if (prior?.secretRef && prior.custody === "temporary") custody.deleteTemporary(prior.secretRef);
    }
    host.recentChannelSetupTests.delete(draftId);
    host.recordDevDiagnostic({
      level: "info",
      category: "integrations",
      event: "channel_setup.secret.updated",
      message: `Updated ${staged.length} secure field${staged.length === 1 ? "" : "s"} for channel draft ${draftId}.`,
      context: {
        draftId,
        catalogId: current.catalogId,
        fieldKeys: staged.map((item) => item.fieldKey),
        revision: updated.revision,
      },
    });
    return updated;
  } catch (error) {
    for (const item of staged) custody.deleteTemporary(item.secretRef);
    throw error;
  }
}

export async function discardChannelSetupDraft(
  host: ChannelSetupHost,
  draftId: string,
  expectedRevision: number,
): Promise<boolean> {
  const current = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(current, expectedRevision);
  const deleted = await host.storage.channelSetupDrafts.delete(draftId, current.revision);
  if (deleted) {
    for (const state of Object.values(current.secretState ?? {})) {
      if (state.secretRef && state.custody === "temporary") host.channelSecrets?.deleteTemporary(state.secretRef);
    }
    host.recentChannelSetupTests.delete(draftId);
  }
  return deleted;
}

export interface ChannelSetupSecretCustodyReconciliationResult {
  scanned: number;
  migrated: number;
  invalidated: number;
  scrubbed: number;
}

/**
 * One-way startup repair for pre-custody drafts. It either moves raw values
 * into the OS keychain or removes them and marks the draft for credential
 * replacement. Raw values and raw legacy hydration are never retained.
 */
export async function reconcileChannelSetupDraftSecretCustody(
  host: ChannelSetupHost,
): Promise<ChannelSetupSecretCustodyReconciliationResult> {
  const definitions = listChannelSetupDefinitionCatalogs();
  const drafts = (
    await Promise.all(
      definitions.map((definition) =>
        host.storage.channelSetupDrafts.listByCatalog(definition.catalog.catalogId, 1_000),
      ),
    )
  ).flat();
  const result: ChannelSetupSecretCustodyReconciliationResult = {
    scanned: drafts.length,
    migrated: 0,
    invalidated: 0,
    scrubbed: 0,
  };

  for (const initial of drafts) {
    const runtime = requireChannelSetupDefinition(initial.catalogId);
    const secretFieldKeys = runtime.definition.adapter.secretFieldKeys;
    let current = initial;
    let invalid = false;
    let touched = Boolean(current.hydration?.rawLegacyConfig);
    const rawValues: Record<string, string> = {};
    const replacementFields = new Set<string>();

    for (const fieldKey of secretFieldKeys) {
      if (!Object.prototype.hasOwnProperty.call(current.draft, fieldKey)) continue;
      touched = true;
      const value = current.draft[fieldKey];
      if (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value !== SECRET_REDACTION_MARKER &&
        host.channelSecrets
      ) {
        rawValues[fieldKey] = value;
      } else if (value !== undefined && value !== null && value !== "" && value !== SECRET_REDACTION_MARKER) {
        invalid = true;
        replacementFields.add(fieldKey);
      } else if (!current.secretState?.[fieldKey]?.configured) {
        invalid = true;
        replacementFields.add(fieldKey);
      }
    }

    if (Object.keys(rawValues).length > 0) {
      try {
        current = await setChannelSetupDraftSecrets(host, current.draftId, {
          expectedRevision: current.revision,
          values: rawValues,
        });
        result.migrated += 1;
      } catch (error) {
        // Conversion failure must still result in a scrubbed, non-callable draft.
        host.recordDevDiagnostic({
          level: "warn",
          category: "integrations",
          event: "channel_setup.secret_reconciliation.conversion_failed",
          message: `Could not migrate legacy credentials for draft ${current.draftId}; replacement is required.`,
          context: {
            draftId: current.draftId,
            catalogId: current.catalogId,
            errorType: error instanceof Error ? error.name : "unknown",
          },
        });
        current = await host.storage.channelSetupDrafts.get(initial.draftId);
        invalid = true;
        for (const fieldKey of Object.keys(rawValues)) replacementFields.add(fieldKey);
      }
    }

    const nextDraft = { ...current.draft };
    const nextSecretState = { ...(current.secretState ?? {}) };
    for (const fieldKey of secretFieldKeys) {
      delete nextDraft[fieldKey];
      const state = nextSecretState[fieldKey];
      if (!state?.configured) continue;
      try {
        if (!state.secretRef) throw new Error("missing channel credential reference");
        requireChannelSecretCustody(host).assertUsableForDraft(state.secretRef, {
          draftId: current.draftId,
          connectionId: current.connectionId,
          fieldKey,
        });
      } catch {
        if (state.secretRef && state.custody === "temporary") host.channelSecrets?.deleteTemporary(state.secretRef);
        nextSecretState[fieldKey] = { configured: false, custody: "temporary" };
        replacementFields.add(fieldKey);
        invalid = true;
        touched = true;
      }
    }
    for (const fieldKey of replacementFields) {
      nextSecretState[fieldKey] = { configured: false, custody: "temporary" };
    }

    const hydration = buildReconciledHydration({ ...current, secretState: nextSecretState }, secretFieldKeys, invalid);
    const needsWrite =
      touched ||
      JSON.stringify(nextDraft) !== JSON.stringify(current.draft) ||
      JSON.stringify(nextSecretState) !== JSON.stringify(current.secretState ?? {}) ||
      JSON.stringify(hydration) !== JSON.stringify(current.hydration);
    if (!needsWrite) continue;

    const updated = await host.storage.channelSetupDrafts.update(current.draftId, {
      expectedRevision: current.revision,
      draft: nextDraft,
      secretState: nextSecretState,
      hydration,
      ...(invalid ? { lastFailureCategory: "credential_rejected" as const } : {}),
    });
    result.scrubbed += 1;
    if (invalid) result.invalidated += 1;
    host.recentChannelSetupTests.delete(current.draftId);
    host.recordDevDiagnostic({
      level: invalid ? "warn" : "info",
      category: "integrations",
      event: invalid
        ? "channel_setup.secret_reconciliation.invalidated"
        : "channel_setup.secret_reconciliation.migrated",
      message: invalid
        ? `Scrubbed draft ${updated.draftId}; one or more credentials must be replaced.`
        : `Migrated draft ${updated.draftId} to secure credential custody.`,
      context: { draftId: updated.draftId, catalogId: updated.catalogId, revision: updated.revision },
    });
  }

  return result;
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
  return testChannelSetupDraft(host, repairDraft.draftId, repairDraft.revision);
}

function assertDraftRevision(draft: ChannelSetupDraft, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || draft.revision !== expectedRevision) {
    throw new Error(
      `Channel setup draft ${draft.draftId} changed after it was loaded (expected revision ${expectedRevision}, current revision ${draft.revision}).`,
    );
  }
}

function custodyInitialDraftSecrets(
  host: ChannelSetupHost,
  draftId: string,
  rawDraft: Record<string, unknown>,
  secretFieldKeys: readonly string[],
): { draft: Record<string, unknown>; secretState: ChannelSetupDraft["secretState"] } {
  const draft = { ...rawDraft };
  const secretState: ChannelSetupDraft["secretState"] = {};
  for (const fieldKey of secretFieldKeys) {
    const value = draft[fieldKey];
    delete draft[fieldKey];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new ValidationError({
        message: `Channel credential field ${fieldKey} must be submitted through secure input.`,
      });
    }
    const custody = requireChannelSecretCustody(host);
    const secretRef = custody.isChannelSecretRef(value) ? value : custody.storeTemporary(draftId, fieldKey, value);
    secretState[fieldKey] = {
      configured: true,
      custody: custody.custodyFor(secretRef),
      secretRef,
    };
  }
  return { draft, secretState };
}

function stripGenericSecretFields(
  draft: Record<string, unknown>,
  secretFieldKeys: readonly string[],
): Record<string, unknown> {
  const next = { ...draft };
  for (const fieldKey of secretFieldKeys) {
    const value = next[fieldKey];
    delete next[fieldKey];
    if (value === undefined || value === null || value === "" || value === SECRET_REDACTION_MARKER) continue;
    throw new ValidationError({
      message: `Channel credential field ${fieldKey} must use the dedicated secure-input endpoint.`,
    });
  }
  return next;
}

function omitSecretFields(draft: Record<string, unknown>, secretFieldKeys: readonly string[]): Record<string, unknown> {
  const next = { ...draft };
  for (const fieldKey of secretFieldKeys) delete next[fieldKey];
  return next;
}

function hydrateChannelSetupDraftSecrets(host: ChannelSetupHost, draft: ChannelSetupDraft): ChannelSetupDraft {
  const next = { ...draft.draft };
  for (const [fieldKey, state] of Object.entries(draft.secretState ?? {})) {
    if (!state.configured || !state.secretRef) continue;
    const custody = requireChannelSecretCustody(host);
    custody.assertUsableForDraft(state.secretRef, {
      draftId: draft.draftId,
      connectionId: draft.connectionId,
      fieldKey,
    });
    next[fieldKey] = custody.resolve(state.secretRef);
  }
  return { ...draft, draft: next };
}

function sanitizeChannelSetupHydration(
  hydration: ChannelSetupDraft["hydration"] | undefined,
): ChannelSetupDraft["hydration"] | undefined {
  if (!hydration) return undefined;
  const { rawLegacyConfig: _rawLegacyConfig, ...safeHydration } = hydration;
  return {
    ...safeHydration,
  };
}

function buildReconciledHydration(
  draft: ChannelSetupDraft,
  secretFieldKeys: readonly string[],
  invalid: boolean,
): ChannelSetupDraft["hydration"] | undefined {
  const sanitized = sanitizeChannelSetupHydration(draft.hydration);
  if (!sanitized && !invalid) return undefined;
  const fieldState = { ...(sanitized?.fieldState ?? {}) };
  if (invalid) {
    for (const fieldKey of secretFieldKeys) {
      if (!draft.secretState?.[fieldKey]?.configured) fieldState[fieldKey] = "needs_replacement";
    }
  }
  return {
    status: invalid ? "invalid-runtime" : (sanitized?.status ?? "clean"),
    fieldState,
    warnings: invalid
      ? [
          ...(sanitized?.warnings ?? []),
          "One or more legacy channel credentials must be replaced through secure input.",
        ]
      : (sanitized?.warnings ?? []),
  };
}

async function persistConnectionWithSecretReferences(
  host: ChannelSetupHost,
  draft: ChannelSetupDraft,
  payload: {
    label: string;
    enabled: boolean;
    status: "connected";
    config: Record<string, unknown>;
    lastSyncAt: string;
    lastError: undefined;
  },
): Promise<IntegrationConnection> {
  const configWithTemporaryRefs = { ...payload.config };
  for (const [fieldKey, state] of Object.entries(draft.secretState ?? {})) {
    if (state.configured && state.secretRef) configWithTemporaryRefs[fieldKey] = state.secretRef;
    else delete configWithTemporaryRefs[fieldKey];
  }

  const initial = draft.connectionId
    ? await host.updateIntegrationConnection(draft.connectionId, { ...payload, config: configWithTemporaryRefs })
    : await host.createIntegrationConnection({
        catalogId: draft.catalogId,
        label: payload.label,
        enabled: payload.enabled,
        status: payload.status,
        config: configWithTemporaryRefs,
      });

  const custody = Object.keys(draft.secretState ?? {}).length > 0 ? requireChannelSecretCustody(host) : undefined;
  const promotedConfig = { ...configWithTemporaryRefs };
  const promotedRefs: string[] = [];
  try {
    for (const [fieldKey, state] of Object.entries(draft.secretState ?? {})) {
      if (!state.configured || !state.secretRef || !custody) continue;
      const promoted = custody.copyToConnection(state.secretRef, initial.connectionId, fieldKey);
      promotedRefs.push(promoted);
      promotedConfig[fieldKey] = promoted;
    }
    const connection = await host.updateIntegrationConnection(initial.connectionId, {
      ...payload,
      config: promotedConfig,
    });
    for (const state of Object.values(draft.secretState ?? {})) {
      if (state.secretRef && state.custody === "temporary") custody?.deleteTemporary(state.secretRef);
    }
    return connection;
  } catch (error) {
    for (const secretRef of promotedRefs) custody?.delete(secretRef);
    throw error;
  }
}

function requireChannelSecretCustody(host: ChannelSetupHost): NonNullable<ChannelSetupHost["channelSecrets"]> {
  if (!host.channelSecrets) {
    throw new ValidationError({ message: "Secure channel credential storage is unavailable." });
  }
  return host.channelSecrets;
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
