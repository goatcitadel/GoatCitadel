// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIntegrationDefaults,
  buildFirstRunEvidenceSnapshot,
  buildChatGptOAuthProviderDraft,
  buildProviderEditorDraft,
  collectDefinitionFieldHints,
  createEmptyProviderEditorDraft,
  createEmptyPersonalityEditorDraft,
  createPersonalityEditorDraft,
  clearStoredOpenAICodexOAuthFlow,
  delay,
  deriveDesktopMobileContinuityItems,
  deriveEcosystemProofLaneItems,
  deriveFirstOutcomePathItems,
  deriveFirstRunGovernedJobState,
  deriveLlamaCppAlias,
  deriveOnboardingProviderSmokeEvidenceItems,
  deriveProviderSmokeEvidenceItems,
  deriveSetupCenterItems,
  describeProviderRequestOverrides,
  describeProviderReadinessFailure,
  describeToolApprovalMode,
  describeToolGrantAvailability,
  describeToolProfile,
  descriptionForSettingsSection,
  formatCapabilities,
  formatCheckedAtLabel,
  formatDateTime,
  formatEffectiveConfigSourceLabel,
  formatJson,
  formatOpenAICodexOAuthExpiry,
  formatPersonalityCategoryLabel,
  formatPersonalityStatus,
  formatProviderCredentialLabel,
  formatProviderModelsMeta,
  formatProviderProbeSourceMeta,
  formatProviderProbeStateLabel,
  getProviderApiStyleWarning,
  getErrorMessage,
  isLikelyLocalProviderBaseUrl,
  isRuntimeInvokableMcpServer,
  isStoredOpenAICodexOAuthFlow,
  isToolGrantAvailable,
  isTrustedOpenAICodexVerificationUrl,
  matchesToolGrant,
  normalizeBudgetMode,
  normalizeOpenAICodexPollDelayMs,
  normalizePersonalityEditorId,
  normalizeToolApprovalMode,
  parseJsonObject,
  personalityDraftToMutationInput,
  preferredChannelDefinition,
  readConnectionConfigString,
  readDraftString,
  readStoredOpenAICodexOAuthFlowFrom,
  readStoredOpenAICodexOAuthFlow,
  removeStoredOpenAICodexOAuthFlow,
  resetLocalOperatorOverrideScopeRefForScope,
  setupMeta,
  splitCommaList,
  splitLineList,
  writeStoredOpenAICodexOAuthFlow,
  wizardStateForChecklist,
  labelForLocalOperatorOverrideScope,
  labelForSettingsSection,
  resolveLocalOperatorOverrideScopeRef,
} from "./SettingsNativePage";

describe("SettingsNativePage helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads trimmed connection config strings only when present", () => {
    expect(readConnectionConfigString(undefined, "oauthConnectedAt")).toBeUndefined();
    expect(readConnectionConfigString({}, "oauthConnectedAt")).toBeUndefined();
    expect(readConnectionConfigString({ oauthConnectedAt: "   " }, "oauthConnectedAt")).toBeUndefined();
    expect(readConnectionConfigString({ oauthConnectedAt: 42 }, "oauthConnectedAt")).toBeUndefined();
    expect(readConnectionConfigString({ oauthConnectedAt: " 2026-05-14T00:00:00.000Z " }, "oauthConnectedAt")).toBe(
      "2026-05-14T00:00:00.000Z",
    );
  });

  it("labels and resolves Local Operator Override scopes", () => {
    expect(labelForLocalOperatorOverrideScope("workspace")).toBe("Current workspace");
    expect(labelForLocalOperatorOverrideScope("session")).toBe("Specific session");
    expect(labelForLocalOperatorOverrideScope("run")).toBe("Specific run");
    expect(labelForLocalOperatorOverrideScope("operator")).toBe("This operator");
    expect(resolveLocalOperatorOverrideScopeRef("workspace", "ignored", "workspace-1")).toBe("workspace-1");
    expect(resolveLocalOperatorOverrideScopeRef("operator", "ignored", "workspace-1")).toBeUndefined();
    expect(resolveLocalOperatorOverrideScopeRef("session", " session-1 ", "workspace-1")).toBe("session-1");
    expect(resolveLocalOperatorOverrideScopeRef("run", "   ", "workspace-1")).toBeUndefined();
    expect(resetLocalOperatorOverrideScopeRefForScope("workspace", "workspace-1")).toBe("workspace-1");
    expect(resetLocalOperatorOverrideScopeRefForScope("session", "workspace-1")).toBe("");
    expect(resetLocalOperatorOverrideScopeRefForScope("run", "workspace-1")).toBe("");
    expect(resetLocalOperatorOverrideScopeRefForScope("operator", "workspace-1")).toBe("");
  });

  it("derives llama.cpp aliases from paths and model filenames", () => {
    expect(deriveLlamaCppAlias("")).toBe("");
    expect(deriveLlamaCppAlias("   ")).toBe("");
    expect(deriveLlamaCppAlias("models\\goat-7b.Q4.gguf")).toBe("goat-7b.Q4");
    expect(deriveLlamaCppAlias("/models/goat-7b.bin")).toBe("goat-7b");
    expect(deriveLlamaCppAlias(".gguf")).toBe(".gguf");
    expect(deriveLlamaCppAlias("/models/goat-7b.safetensors")).toBe("goat-7b.safetensors");
  });

  it("resolves delay through the browser timer", async () => {
    vi.useFakeTimers();
    const delayed = delay(25);

    vi.advanceTimersByTime(24);
    let resolved = false;
    delayed.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await delayed;
    expect(resolved).toBe(true);
  });

  it("normalizes setup, budget, approval, and settings copy helpers", () => {
    const onboarding = {
      checklist: [
        { id: "llm", status: "complete" },
        { id: "runtime", status: "needs_input", detail: "Runtime missing." },
        { id: "auth", status: "pending" },
      ],
      settings: {
        auth: { mode: "token" },
        budgetMode: "balanced",
        llm: {
          activeModel: "gpt-5",
          providers: [
            { providerId: "openai", label: "OpenAI", hasApiKey: true },
            { providerId: "local", label: "Local", hasApiKey: false },
          ],
        },
      },
    } as any;

    expect(deriveSetupCenterItems(onboarding).map((item) => item.state)).toEqual([
      "complete",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(
      deriveSetupCenterItems({
        checklist: [{ id: "llm", status: "pending" }],
        settings: {
          auth: { mode: "none" },
          budgetMode: "balanced",
          llm: {
            activeModel: "",
            providers: [{ providerId: "local", label: "Local", hasApiKey: true }],
          },
        },
      } as any).map((item) => item.description),
    ).toEqual(
      expect.arrayContaining([
        "1 provider credential source available. Active model: unset.",
        "Gateway and bundled runtime health are checked locally.",
        "Local access is open; add gateway auth before exposing the app.",
      ]),
    );
    expect(wizardStateForChecklist("complete" as any)).toBe("complete");
    expect(wizardStateForChecklist("needs_input" as any)).toBe("active");
    expect(wizardStateForChecklist("blocked" as any)).toBe("pending");
    expect(setupMeta("complete" as any)).toBe("Pass");
    expect(setupMeta("needs_input" as any)).toBe("Needs repair");
    expect(setupMeta(undefined)).toBe("Optional");
    expect(normalizeToolApprovalMode("bypass")).toBe("bypass");
    expect(normalizeToolApprovalMode("bad")).toBe("approve_risky");
    expect(describeToolApprovalMode("approve_all")).toBe("Ask every time");
    expect(describeToolApprovalMode("approve_risky")).toBe("Ask for risky work");
    expect(describeToolApprovalMode("bypass")).toBe("Skip normal prompts");
    expect(describeToolProfile("danger")).toContain("prompt behavior still comes from the approval mode");
    expect(describeToolProfile("danger")).not.toContain("skips normal prompts");
    expect(normalizeBudgetMode("power")).toBe("power");
    expect(normalizeBudgetMode("turbo")).toBe("balanced");
    expect(labelForSettingsSection("mcp")).toBe("MCP");
    expect(labelForSettingsSection("permissions")).toBe("Permissions");
    expect(labelForSettingsSection("missing")).toBe("Unknown");
    expect(descriptionForSettingsSection("addons")).toContain("experimental local add-ons");
    expect(descriptionForSettingsSection("permissions")).toContain("permission profiles");
    expect(descriptionForSettingsSection("missing")).toContain("not registered");
  });

  it("derives a plain-English first-outcome path from provider and demo state", () => {
    const missingProviderOnboarding = {
      checklist: [],
      settings: {
        auth: { mode: "none" },
        budgetMode: "balanced",
        llm: {
          activeProviderId: "",
          activeModel: "",
          providers: [],
        },
      },
    } as any;

    expect(describeProviderReadinessFailure(missingProviderOnboarding)).toBe(
      "Choose an active provider before sending cloud-backed work.",
    );
    expect(deriveFirstOutcomePathItems(missingProviderOnboarding, null).map((item) => item.state)).toEqual([
      "active",
      "active",
      "active",
      "pending",
      "pending",
    ]);
    expect(deriveFirstRunGovernedJobState(missingProviderOnboarding, null)).toBe("provider-missing");

    const readyProviderOnboarding = {
      checklist: [],
      settings: {
        auth: { mode: "token" },
        budgetMode: "balanced",
        llm: {
          activeProviderId: "openai",
          activeModel: "gpt-5",
          providers: [{ providerId: "openai", label: "OpenAI", hasApiKey: true }],
        },
      },
    } as any;

    const providerItems = deriveFirstOutcomePathItems(readyProviderOnboarding, null);
    expect(providerItems.map((item) => item.label)).toEqual([
      "Provider-ready path",
      "Provider missing fallback",
      "Demo/local path",
      "First Chat/Cowork/Code task",
      "Proof artifact or trace",
    ]);
    expect(providerItems.map((item) => item.state)).toEqual(["complete", "pending", "pending", "active", "pending"]);
    expect(providerItems[0]!.description).toContain("risky actions still stay approval-governed");
    expect(providerItems[3]!.meta).toBe("first-task-pending");
    expect(deriveFirstRunGovernedJobState(readyProviderOnboarding, null)).toBe("provider-ready");
    expect(deriveOnboardingProviderSmokeEvidenceItems(readyProviderOnboarding).map((item) => item.label)).toEqual([
      "Provider configured",
      "Smoke ready",
      "Passed with evidence",
    ]);
    expect(deriveOnboardingProviderSmokeEvidenceItems(readyProviderOnboarding).map((item) => item.state)).toEqual([
      "complete",
      "complete",
      "active",
    ]);

    const demoItems = deriveFirstOutcomePathItems(readyProviderOnboarding, {
      status: "ready",
      workspace: { workspaceId: "workspace-1", name: "Demo", slug: "demo" },
      project: { projectId: "project-1", name: "Demo Project", workspacePath: "F:\\code\\demo" },
      sessions: [
        { sessionId: "chat-1", title: "Chat", mode: "chat", projectId: "project-1" },
        { sessionId: "cowork-1", title: "Cowork", mode: "cowork", projectId: "project-1" },
        { sessionId: "code-1", title: "Code", mode: "code", projectId: "project-1" },
      ],
      tasks: [{ taskId: "task-1", title: "Cowork adoption tour", status: "open", priority: "medium" }],
      starterPrompts: [],
      memorySeeds: [],
      nextRoute: "/chat",
      notes: [],
    } as any);
    expect(demoItems.map((item) => item.state)).toEqual(["complete", "pending", "complete", "active", "active"]);
    expect(demoItems[3]!.meta).toBe("starter-ready");
    expect(demoItems.at(-1)!.meta).toBe("proof-needed");
    expect(demoItems[3]!.actionLabel).toBe("Open Cowork");
    expect(demoItems[3]!.route).toEqual({ area: "cowork", sessionId: "cowork-1", projectId: "project-1" });

    const durableTaskItems = deriveFirstOutcomePathItems(readyProviderOnboarding, null, {
      recentRuns: [
        {
          taskId: "task-1",
          runId: "run-no-proof-yet",
          title: "First run",
          taskStatus: "running",
          status: "running",
          surface: "code",
          parentSessionId: "code-session-1",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      evidenceEnvelopes: [],
    });
    expect(durableTaskItems[3]!.description).toContain("recent durable code exists");
    expect(durableTaskItems[3]!.actionLabel).toBe("Open Run Detail");
    expect(durableTaskItems[3]!.route).toEqual({
      area: "ops",
      section: "sessions",
      view: "run-detail",
      runId: "run-no-proof-yet",
      sessionId: "code-session-1",
    });

    const unknownSurfaceItems = deriveFirstOutcomePathItems(readyProviderOnboarding, null, {
      recentRuns: [
        {
          taskId: "task-1",
          runId: "run-unknown-surface",
          title: "First run",
          taskStatus: "running",
          status: "running",
          parentSessionId: "session-1",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      evidenceEnvelopes: [],
    });
    expect(unknownSurfaceItems[3]!.description).toContain("recent durable run exists");
    expect(unknownSurfaceItems[3]!.description).not.toContain("Cowork run");

    expect(
      deriveFirstRunGovernedJobState(readyProviderOnboarding, null, {
        recentRuns: [
          {
            taskId: "task-1",
            runId: "run-1",
            title: "First run",
            taskStatus: "done",
            status: "completed",
            surface: "cowork",
            parentSessionId: "cowork-1",
            updatedAt: "2026-05-30T00:00:00.000Z",
          },
        ],
        evidenceEnvelopes: [
          {
            envelopeId: "env-1",
            eventKind: "durable_checkpoint",
            runId: "run-1",
            contentHash: "hash",
            payloadHash: "payload",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-05-30T00:00:00.000Z",
          },
        ],
      }),
    ).toBe("proof-complete");

    expect(
      buildFirstRunEvidenceSnapshot(
        [
          {
            taskId: "task-1",
            runId: "run-1",
            title: "First run",
            taskStatus: "done",
            status: "completed",
            updatedAt: "2026-05-30T00:00:00.000Z",
          } as any,
        ],
        [
          {
            envelopeId: "env-unrelated",
            eventKind: "memory_write",
            contentHash: "hash",
            payloadHash: "payload",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-05-30T00:00:00.000Z",
          },
          {
            envelopeId: "env-other-run",
            eventKind: "durable_checkpoint",
            runId: "run-other",
            contentHash: "hash",
            payloadHash: "payload",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-05-30T00:00:00.000Z",
          },
          {
            envelopeId: "env-run-1",
            eventKind: "durable_checkpoint",
            runId: "run-1",
            contentHash: "hash",
            payloadHash: "payload",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-05-30T00:00:00.000Z",
          },
        ] as any,
      ).evidenceEnvelopes.map((envelope) => envelope.envelopeId),
    ).toEqual(["env-run-1"]);
  });

  it("orders ecosystem proof lanes without over-claiming blocked parity", () => {
    const lanes = deriveEcosystemProofLaneItems();

    expect(lanes.map((item) => item.label)).toEqual([
      "Voice Wake / Talk Mode",
      "Browser control",
      "Extension / plugin SDK breadth",
      "Packaging and remote deployment parity",
      "Mobile companion/device surfaces",
      "Canvas / A2UI parity",
    ]);
    expect(lanes[1]!.route).toEqual({ area: "settings", section: "mcp" });
    expect(lanes[3]!.description).toContain("named packaging proof");
  });

  it("derives desktop and mobile continuity from daemon and device-grant truth", () => {
    const items = deriveDesktopMobileContinuityItems({
      settings: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          tokenConfigured: true,
          basicConfigured: false,
        },
      } as any,
      grants: [
        {
          grantId: "grant-mobile",
          requestId: "request-mobile",
          actorId: "operator",
          deviceLabel: "Phone",
          deviceType: "mobile",
          platform: "Android",
          grantedBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          metadata: {},
        },
      ],
      daemon: {
        running: true,
        pid: 1234,
        uptimeSeconds: 60,
        host: "desktop",
        state: "running",
        supported: true,
        controllable: true,
        controlMessage: "Ready",
      },
    });

    expect(items.find((item) => item.id === "desktop-runtime")?.actionLabel).toBe("Ready");
    expect(items.find((item) => item.id === "mobile-trust")?.description).toContain("1 active mobile/tablet");
    expect(items.find((item) => item.id === "install-token")?.actionLabel).toBe("Pairable");
  });

  it("handles JSON, list, channel, tool, and integration helper edges", () => {
    expect(parseJsonObject("")).toEqual({});
    expect(parseJsonObject("", { fallback: true })).toEqual({ fallback: true });
    expect(parseJsonObject('{"enabled":true}')).toEqual({ enabled: true });
    expect(() => parseJsonObject("[]")).toThrow("JSON object");
    expect(splitCommaList(" alpha, , beta ")).toEqual(["alpha", "beta"]);
    expect(splitLineList("one\r\n \ntwo")).toEqual(["one", "two"]);
    expect(readDraftString({ key: "  value " }, "key")).toBe("value");
    expect(readDraftString({ key: 1 }, "key")).toBeUndefined();
    expect(matchesToolGrant({ toolPattern: "browser.*" } as any, "browser.search")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "*" } as any, "browser.search")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "*.search" } as any, "browser.search")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "mcp.*.invoke" } as any, "mcp.github.invoke")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "mcp.*.invoke" } as any, "mcp.github.read")).toBe(false);
    expect(matchesToolGrant({ toolPattern: "browser.search" } as any, "browser.search")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "browser.open" } as any, "browser.search")).toBe(false);
    expect(
      isToolGrantAvailable(
        { grantType: "ttl", expiresAt: "2026-05-17T00:10:00.000Z" } as any,
        Date.parse("2026-05-17T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isToolGrantAvailable(
        { grantType: "ttl", expiresAt: "2026-05-16T23:59:00.000Z" } as any,
        Date.parse("2026-05-17T00:00:00.000Z"),
      ),
    ).toBe(false);
    expect(isToolGrantAvailable({ grantType: "persistent", revokedAt: "2026-05-17T00:00:00.000Z" } as any)).toBe(false);
    expect(isToolGrantAvailable({ grantType: "one_time", usesRemaining: 0 } as any)).toBe(false);
    expect(isToolGrantAvailable({ grantType: "one_time", usesRemaining: 1 } as any)).toBe(true);
    expect(
      describeToolGrantAvailability(
        { grantType: "ttl", expiresAt: "2026-05-16T23:59:00.000Z" } as any,
        Date.parse("2026-05-17T00:00:00.000Z"),
      ),
    ).toContain("expired");
    expect(describeToolGrantAvailability({ grantType: "one_time", usesRemaining: 0 } as any)).toBe("exhausted");
    expect(isRuntimeInvokableMcpServer({ transport: "stdio" })).toBe(true);
    expect(isRuntimeInvokableMcpServer({ transport: "http", url: " goatcitadel://approval-inbox " })).toBe(true);
    expect(isRuntimeInvokableMcpServer({ transport: "http", url: "https://example.test" })).toBe(false);

    const schema = {
      fields: [
        { key: "present", defaultValue: "ignored" },
        { key: "missing", defaultValue: "filled" },
        { key: "none" },
      ],
    } as any;
    expect(applyIntegrationDefaults(schema, { present: "kept" })).toEqual({ present: "kept", missing: "filled" });

    const definition = (catalogId: string) =>
      ({
        catalog: { catalogId },
        wizard: { steps: [{ fields: [{ label: "Token", explanation: "API token", type: "secret" }] }] },
      }) as any;
    expect(
      preferredChannelDefinition([definition("channel.telegram"), definition("channel.slack")])?.catalog.catalogId,
    ).toBe("channel.slack");
    expect(preferredChannelDefinition([definition("channel.telegram")])?.catalog.catalogId).toBe("channel.telegram");
    expect(preferredChannelDefinition([])).toBeUndefined();
    expect(collectDefinitionFieldHints(definition("channel.slack"))).toEqual([
      { label: "Token", explanation: "API token", type: "secret" },
    ]);
    expect(collectDefinitionFieldHints({ catalog: { catalogId: "empty" }, wizard: { steps: [{}] } } as any)).toEqual(
      [],
    );
  });

  it("formats provider, OAuth, capability, and personality helper states", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const flow = {
      providerId: "openai-codex" as const,
      flowId: "flow-1",
      verificationUrl: "https://auth.openai.com/activate",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-05-14T12:03:00.000Z",
      pollAfterMs: 5000,
    };
    expect(isTrustedOpenAICodexVerificationUrl(flow.verificationUrl)).toBe(true);
    expect(isTrustedOpenAICodexVerificationUrl("https://evil.example/activate")).toBe(false);
    expect(isTrustedOpenAICodexVerificationUrl("not a url")).toBe(false);
    expect(normalizeOpenAICodexPollDelayMs(250)).toBe(1000);
    expect(normalizeOpenAICodexPollDelayMs(Number.POSITIVE_INFINITY)).toBe(5000);
    expect(normalizeOpenAICodexPollDelayMs(-1)).toBe(5000);
    expect(normalizeOpenAICodexPollDelayMs("soon")).toBe(5000);
    expect(isStoredOpenAICodexOAuthFlow(flow)).toBe(true);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, userCode: undefined })).toBe(true);
    expect(isStoredOpenAICodexOAuthFlow(null)).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, providerId: "openai" })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, flowId: "   " })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, verificationUrl: "https://auth.openai.com.evil/activate" })).toBe(
      false,
    );
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, expiresAt: "2026-05-14T11:59:00.000Z" })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, userCode: "   " })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, expiresAt: 123 })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, pollAfterMs: 0 })).toBe(false);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, pollAfterMs: Number.NaN })).toBe(false);
    expect(formatOpenAICodexOAuthExpiry(flow)).toBe("3 minutes");
    expect(formatOpenAICodexOAuthExpiry(null)).toBeNull();
    expect(formatOpenAICodexOAuthExpiry({ ...flow, expiresAt: "bad-date" })).toBeNull();
    expect(formatOpenAICodexOAuthExpiry({ ...flow, expiresAt: "2026-05-14T12:00:10.000Z" })).toBe("1 minute");
    expect(formatOpenAICodexOAuthExpiry({ ...flow, expiresAt: "2026-05-14T17:00:00.000Z" })).toBeNull();
    expect(isLikelyLocalProviderBaseUrl("http://192.168.1.20:8000/v1")).toBe(true);
    expect(isLikelyLocalProviderBaseUrl("http://10.0.0.5:11434")).toBe(true);
    expect(isLikelyLocalProviderBaseUrl("http://172.16.2.5:11434")).toBe(true);
    expect(isLikelyLocalProviderBaseUrl(undefined)).toBe(false);
    expect(isLikelyLocalProviderBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(formatProviderProbeStateLabel("ready")).toBe("Verified");
    expect(formatProviderProbeStateLabel("fallback")).toBe("Suggested");
    expect(formatProviderProbeStateLabel("empty")).toBe("No models");
    expect(formatProviderProbeStateLabel("error")).toBe("Unreachable");
    expect(formatProviderProbeStateLabel(undefined)).toBe("Not checked");
    expect(formatProviderProbeSourceMeta()).toBe("Not checked yet");
    expect(formatProviderProbeSourceMeta({ modelProbeSource: "template_fallback" })).toContain("Template");
    expect(formatProviderProbeSourceMeta({ modelProbeState: "fallback" })).toContain("Template");
    expect(formatProviderProbeSourceMeta({ modelProbeSource: "error_fallback", modelProbeWarning: "401" })).toContain(
      "401",
    );
    expect(formatProviderProbeSourceMeta({ modelProbeSource: "error_fallback" })).toBe("Fallback after probe error");
    expect(formatProviderProbeSourceMeta({ modelProbeState: "error", modelProbeWarning: "proxy failed" })).toBe(
      "Live discovery failed: proxy failed",
    );
    expect(formatProviderModelsMeta(undefined, 0)).toBe("Not probed");
    expect(formatProviderModelsMeta({ modelProbeState: "ready", modelProbeSource: "live" }, 2)).toBe("Live verified");
    expect(formatProviderModelsMeta({ modelProbeState: "ready", modelProbeSource: "live" }, 0)).toBe(
      "No verified model list",
    );
    expect(formatProviderModelsMeta({ modelProbeState: "fallback", modelProbeSource: "template_fallback" }, 3)).toBe(
      "Suggested, not account-verified",
    );
    expect(formatProviderModelsMeta({ modelProbeState: "error", modelProbeSource: "error_fallback" }, 0)).toBe(
      "Probe failed",
    );
    expect(formatProviderModelsMeta({ modelProbeState: "empty", modelProbeSource: "live" }, 0)).toBe(
      "No verified model list",
    );
    expect(getProviderApiStyleWarning({ providerId: "openai", apiStyle: "openai-codex-responses" })).toContain(
      "only executed",
    );
    expect(getProviderApiStyleWarning({ providerId: "openai-codex", apiStyle: "openai-codex-responses" })).toBeNull();
    expect(formatCheckedAtLabel()).toBe("Not checked yet");
    expect(formatCheckedAtLabel("not-a-date")).toBe("Last check unavailable");
    expect(formatCheckedAtLabel("2026-05-14T12:00:00.000Z")).toContain("2026");
    expect(formatProviderCredentialLabel("openai-codex", false, { connected: true } as any)).toBe("OAuth connected");
    expect(formatProviderCredentialLabel("openai-codex", false, { requiresReauth: true } as any)).toBe("OAuth reauth");
    expect(formatProviderCredentialLabel("openai-codex", false, null)).toBe("OAuth missing");
    expect(formatProviderCredentialLabel("openai", true, null)).toBe("secret ready");
    expect(formatProviderCredentialLabel("openai", false, null)).toBe("secret missing");
    expect(formatEffectiveConfigSourceLabel("env")).toBe("env");
    expect(formatEffectiveConfigSourceLabel("inline")).toBe("UI");
    expect(formatEffectiveConfigSourceLabel("keychain")).toBe("secure store");
    expect(formatEffectiveConfigSourceLabel("default")).toBe("default");
    expect(formatEffectiveConfigSourceLabel(undefined)).toBe("unknown");
    expect(formatCapabilities(undefined)).toBe("No capability metadata");
    expect(formatCapabilities({ vision: true, jsonMode: false, reasoning: true })).toBe("vision, reasoning");
    expect(formatCapabilities({ vision: false, jsonMode: false, toolCalling: false })).toBe(
      "No advertised capabilities",
    );
    expect(
      describeProviderRequestOverrides({
        auth: { type: "bearer", tokenEnv: "PROVIDER_TOKEN" },
        proxy: { url: "http://proxy.local" },
        tls: { caCertPath: "ca.pem", serverName: "provider.local" },
      }),
    ).toBe("bearer auth, proxy, TLS CA cert/server name");
    expect(
      deriveProviderSmokeEvidenceItems({
        providerId: "openai",
        providerLabel: "OpenAI",
        credentialReady: true,
        credentialMeta: "secure store",
        localEndpoint: false,
        modelCount: 0,
        modelProbeState: "error",
        modelProbeWarning: "401 Unauthorized",
      }).map((item) => item.description),
    ).toEqual(expect.arrayContaining([expect.stringContaining("Blocked by model discovery failure")]));
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("boom")).toBe("boom");
    expect(formatJson({ enabled: true })).toBe('{\n  "enabled": true\n}');
    expect(formatDateTime(undefined)).toBe("Unknown");
    expect(formatDateTime("not-a-date")).toBe("Unknown");
    expect(formatDateTime("2026-05-14T12:00:00.000Z")).toContain("2026");

    const draft = createEmptyPersonalityEditorDraft();
    expect(draft.category).toBe("core");
    expect(personalityDraftToMutationInput({ ...draft, label: "  Label ", safetyNotes: "one\n\ntwo" })).toEqual(
      expect.objectContaining({ label: "Label", safetyNotes: ["one", "two"] }),
    );
    expect(
      createPersonalityEditorDraft({
        id: "critic",
        label: "Critic",
        category: "critical",
        description: "Hard review",
        tone: "direct",
        style: "concise",
        systemOverlay: "Review",
        safetyNotes: ["Stay safe"],
      } as any),
    ).toEqual(expect.objectContaining({ id: "critic", safetyNotes: "Stay safe" }));
    expect(createPersonalityEditorDraft(null)).toEqual(expect.objectContaining({ id: "", category: "core" }));
    expect(
      formatPersonalityStatus({ id: "critic", builtin: false, modified: true, editable: false } as any, "critic"),
    ).toBe("Custom · Modified · Chat default · Locked");
    expect(
      formatPersonalityStatus({ id: "operator", builtin: true, modified: false, editable: true } as any, "critic"),
    ).toBe("Built-in");
    expect(formatPersonalityCategoryLabel("critical")).toBe("Critical");
    expect(formatPersonalityCategoryLabel("research_assistant" as any)).toBe("Research Assistant");
    expect(normalizePersonalityEditorId("  Hello World!! ")).toBe("hello-world");
    expect(normalizePersonalityEditorId(" ! ")).toBe("default");
  });

  it("covers provider and setup helper tails that stay pure", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    expect(isTrustedOpenAICodexVerificationUrl("http://auth.openai.com/codex/device")).toBe(false);
    expect(formatProviderProbeSourceMeta({ modelProbeSource: "live", modelProbeCheckedAt: "bad-date" })).toBe(
      "Last check unavailable",
    );
    expect(
      formatProviderProbeSourceMeta({
        modelProbeSource: "live",
        modelProbeCheckedAt: "2026-05-14T12:00:00.000Z",
      }),
    ).toContain("2026");
    expect(
      formatProviderCredentialLabel("openai-codex", true, { connected: false, requiresReauth: false } as any),
    ).toBe("OAuth missing");

    const manyFields = {
      catalog: { catalogId: "channel.test" },
      wizard: {
        steps: [
          {
            fields: Array.from({ length: 12 }, (_, index) => ({
              label: `Field ${index}`,
              explanation: `Explanation ${index}`,
              type: "text",
            })),
          },
        ],
      },
    } as any;
    expect(collectDefinitionFieldHints(manyFields)).toHaveLength(10);

    const providerRichOnboarding = {
      checklist: [],
      settings: {
        auth: { mode: "token" },
        budgetMode: "economy",
        llm: {
          activeModel: "gpt-5",
          providers: [
            { providerId: "openai", label: "OpenAI", hasApiKey: true },
            { providerId: "anthropic", label: "Anthropic", hasApiKey: true },
          ],
        },
      },
    } as any;
    expect(deriveSetupCenterItems(providerRichOnboarding).map((item) => item.description)).toEqual(
      expect.arrayContaining([
        "2 provider credential source available. Active model: gpt-5.",
        "token gateway auth configured.",
      ]),
    );
  });

  it("cleans invalid stored OAuth flows from provided storage", () => {
    const removed: string[] = [];
    const storage = {
      getItem: vi.fn(() => "{bad json"),
      removeItem: vi.fn((key: string) => removed.push(key)),
    } as unknown as Storage;

    expect(readStoredOpenAICodexOAuthFlowFrom(undefined)).toBeNull();
    expect(readStoredOpenAICodexOAuthFlowFrom(storage)).toBeNull();
    expect(removed).toHaveLength(1);
    removeStoredOpenAICodexOAuthFlow(storage);
    expect(removed).toHaveLength(2);

    const emptyStorage = {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    } as unknown as Storage;
    expect(readStoredOpenAICodexOAuthFlowFrom(emptyStorage)).toBeNull();
    expect(emptyStorage.removeItem as any).not.toHaveBeenCalled();
  });

  it("returns valid stored OAuth flows and tolerates broken storage APIs", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const flow = {
      providerId: "openai-codex" as const,
      flowId: "flow-1",
      verificationUrl: "https://auth.openai.com/activate",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-05-14T12:03:00.000Z",
      pollAfterMs: 5000,
    };
    const validStorage = {
      getItem: vi.fn(() => JSON.stringify(flow)),
      removeItem: vi.fn(),
    } as unknown as Storage;
    expect(readStoredOpenAICodexOAuthFlowFrom(validStorage)).toEqual(flow);
    expect(validStorage.removeItem as any).not.toHaveBeenCalled();

    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("remove blocked");
      }),
    } as unknown as Storage;
    expect(readStoredOpenAICodexOAuthFlowFrom(throwingStorage)).toBeNull();
    expect(() => removeStoredOpenAICodexOAuthFlow(throwingStorage)).not.toThrow();
  });

  it("builds provider editor drafts and tolerates browser storage failures", () => {
    expect(createEmptyProviderEditorDraft()).toEqual({
      providerId: "",
      label: "",
      baseUrl: "",
      apiStyle: "openai-responses",
      defaultModel: "",
      apiKeyEnv: "",
    });
    expect(buildProviderEditorDraft(null)).toEqual(createEmptyProviderEditorDraft());
    expect(
      buildProviderEditorDraft({
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-opus-5",
        apiKeySource: "env",
        apiKeyRef: "ANTHROPIC_API_KEY",
      }),
    ).toEqual({
      providerId: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      apiStyle: "anthropic-messages",
      defaultModel: "claude-opus-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(
      buildProviderEditorDraft({
        providerId: "local",
        label: "Local",
        baseUrl: "http://localhost:11434",
        defaultModel: "llama",
        apiKeySource: "keychain",
        apiKeyRef: "LOCAL_KEY",
      }),
    ).toEqual(expect.objectContaining({ apiStyle: "openai-responses", apiKeyEnv: "" }));
    expect(buildChatGptOAuthProviderDraft()).toEqual(
      expect.objectContaining({
        providerId: "openai-codex",
        apiStyle: "openai-codex-responses",
        apiKeyEnv: "",
      }),
    );

    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const flow = {
      providerId: "openai-codex" as const,
      flowId: "flow-browser",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-1234",
      expiresAt: "2026-05-14T12:10:00.000Z",
      pollAfterMs: 5000,
    };
    const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const localStore = new Map<string, string>();
    const sessionStore = new Map<string, string>();
    const storage = (store: Map<string, string>) =>
      ({
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
      }) as unknown as Storage;

    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage(localStore) });
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(sessionStore) });
      writeStoredOpenAICodexOAuthFlow(flow);
      expect(readStoredOpenAICodexOAuthFlow()).toEqual(flow);
      clearStoredOpenAICodexOAuthFlow();
      expect(readStoredOpenAICodexOAuthFlow()).toBeNull();

      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("local blocked");
        },
      });
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
          throw new Error("session blocked");
        },
      });
      expect(readStoredOpenAICodexOAuthFlow()).toBeNull();
      expect(() => writeStoredOpenAICodexOAuthFlow(flow)).not.toThrow();
      expect(() => clearStoredOpenAICodexOAuthFlow()).not.toThrow();

      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          setItem: vi.fn(() => {
            throw new Error("set blocked");
          }),
        },
      });
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(sessionStore) });
      expect(() => writeStoredOpenAICodexOAuthFlow(flow)).not.toThrow();
    } finally {
      if (previousLocalStorage) {
        Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
      }
      if (previousSessionStorage) {
        Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
      }
    }
  });
});
