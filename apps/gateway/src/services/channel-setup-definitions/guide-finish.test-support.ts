/**
 * Test support for setup-guide copy tests that ask "can a person finish this guide?".
 *
 * The real Continue logic lives in Mission Control (`findMissingFieldLabels` in `channel-wizard-model.ts`). This
 * module mirrors it for gateway-side tests: `continueBlockers` lists what the wizard would still ask for, with the same
 * field labels. It does not model saved secrets, target lists or the Discord token special case.
 *
 * `verdictOf` does what the setup test does: the structural checks plus the live send against a fake network, every
 * non-pass check becomes an issue, then the Gateway decides whether Finalize is allowed.
 *
 *   const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.line");
 */
import { vi } from "vitest";
import type {
  ChannelSetupDraft,
  ChannelSetupIssue,
  ChannelSetupTestResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { evaluateChannelSetupEligibility } from "../channel-setup-eligibility.js";
import { isPermittedIntegrationSecretEnvVarName } from "../gateway/integration-secret-envvar-guard.js";
import {
  buildIntegrationConnectionChecks,
  runIntegrationConnectionLiveChecks,
  type IntegrationDiagnosticsPort,
} from "../integration-diagnostics-service.js";

const DRAFT_ID = "22222222-2222-2222-2222-222222222222";
const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const TIMESTAMP = "2026-03-29T00:00:00.000Z";

export interface GuideFinishOptions {
  /** The fake network. Without it every request is answered with 200 and `{}`. */
  fetch?: IntegrationDiagnosticsPort["fetchWithDiagnosticsTimeout"];
  /**
   * The Gateway's network allowlist. Without it, every fixed host the guide lists for the channel is allowed, as the
   * "Allow these hosts" button leaves it; a test of the hosts check passes the list it wants.
   */
  networkAllowlist?: string[];
}

/** Whether the wizard counts a value as filled in (`hasFieldValue`, without the saved-secret state). */
function isFilled(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/** The helpers for one guide, looked up by catalog id (for example "channel.line") each time they are used. */
export function guideFinish(catalogId: string, options: GuideFinishOptions = {}) {
  const runtime = () => requireChannelSetupDefinition(catalogId);

  function draftOf(
    values: Record<string, unknown>,
    extra: Partial<ChannelSetupDraft> = {},
    lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
  ): ChannelSetupDraft {
    return {
      draftId: DRAFT_ID,
      catalogId,
      lifecycleMode,
      enabled: true,
      draft: values,
      revision: 1,
      secretState: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      ...extra,
    };
  }

  function connectionOf(config: Record<string, unknown>): IntegrationConnection {
    const { catalog } = runtime().definition;
    return {
      connectionId: CONNECTION_ID,
      catalogId,
      kind: "channel",
      key: catalog.key,
      label: catalog.label,
      revision: "1",
      enabled: true,
      status: "connected",
      config,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
  }

  /**
   * What Continue would still ask for, as the labels the person sees, step by step: the visible required fields, then
   * each "any of" group by the labels of its fields. A key with no field is not named, and a label is named once.
   * Setup-only steps are skipped when a saved connection is changed.
   */
  function continueBlockers(
    values: Record<string, unknown>,
    lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
  ): string[] {
    const steps = runtime().definition.wizard.steps;
    const allFields = steps.flatMap((step) => step.fields ?? []);
    const effective: Record<string, unknown> = {
      ...Object.fromEntries(
        allFields.filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue]),
      ),
      ...values,
    };
    const filled = (key: string) => isFilled(effective[key]);
    const holds = (condition: { fieldKey: string; value: unknown } | undefined) =>
      !condition || effective[condition.fieldKey] === condition.value;
    return steps.flatMap((step) => {
      if (!holds(step.visibleWhenFieldEquals)) return [];
      if (lifecycleMode !== "create" && step.createOnly) return [];
      const missingFields = (step.fields ?? [])
        .filter((field) => holds(field.visibleWhenFieldEquals) && field.required && !filled(field.key))
        .map((field) => field.label);
      const missingGroups = (step.requiredAnyOf ?? [])
        .filter((group) => !group.some(filled))
        .map((group) => [...new Set(group.flatMap((key) => allFields.find((field) => field.key === key)?.label ?? []))])
        .filter((labels) => labels.length > 0)
        .map((labels) => labels.join(" or "));
      return [...missingFields, ...missingGroups];
    });
  }

  /** The fixed hosts the guide lists for the channel, whatever the mode: the allowlist a finished setup has. */
  function fixedHosts(): string[] {
    const { requiredHosts = [], conditionalHosts = [] } = runtime().definition.wizard;
    return [...new Set([...requiredHosts, ...conditionalHosts.map((rule) => rule.host)])];
  }

  /** The Gateway's diagnostics port with a fake network, the fixed hosts allowed and every address allowed. */
  function port(): IntegrationDiagnosticsPort {
    const readString = (values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    };
    return {
      config: {
        toolPolicy: {
          tools: { profile: "default" },
          sandbox: { networkAllowlist: [...(options.networkAllowlist ?? fixedHosts())] },
        },
      } as unknown as IntegrationDiagnosticsPort["config"],
      fetchWithDiagnosticsTimeout: vi.fn(
        options.fetch ?? (async () => new Response("{}", { status: 200 })),
      ) as IntegrationDiagnosticsPort["fetchWithDiagnosticsTimeout"],
      getDiscordRuntimeStatus: vi.fn(() => undefined),
      isConnectionUrlAllowlisted: vi.fn(() => true),
      readConnectionConfigValue: vi.fn(readString),
      // Like GatewayService.resolveConnectionSecret: the direct value, else the variable the config names, if the guard permits that name.
      resolveConnectionSecret: vi.fn((values, directKey, envKey, catalogId) => {
        const direct = readString(values, directKey)?.trim();
        if (direct) return direct;
        const envName = readString(values, envKey)?.trim();
        return envName && isPermittedIntegrationSecretEnvVarName(envName, catalogId) ? process.env[envName] : undefined;
      }),
    };
  }

  /** The setup test for this config. `deps` is the fake port, so a test can look at the requests that were sent. */
  async function verdictOf(config: Record<string, unknown>) {
    const connection = connectionOf(config);
    const deps = port();
    const live = await runIntegrationConnectionLiveChecks(deps, connection, { includeSandboxSend: true });
    const issues: ChannelSetupIssue[] = [...buildIntegrationConnectionChecks(deps, connection), ...live.checks]
      .filter((check) => check.status !== "pass")
      .map((check) => ({
        key: check.key,
        level: check.status === "fail" ? ("error" as const) : ("warn" as const),
        message: check.message,
      }));
    const result: ChannelSetupTestResult = {
      draftId: DRAFT_ID,
      draftRevision: 1,
      status: issues.some((issue) => issue.level === "error") ? "error" : issues.length > 0 ? "warn" : "ok",
      levels: [],
      issues,
      ...(live.probe ? { probe: live.probe } : {}),
      checkedAt: TIMESTAMP,
    };
    return { deps, live, issues, eligibility: evaluateChannelSetupEligibility(result, connection) };
  }

  return { draftOf, connectionOf, continueBlockers, port, verdictOf };
}
