import { describe, expect, it, vi } from "vitest";
import type { CapabilityGapCauseClass, ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildCapabilityGapFingerprint,
  buildRepairCandidateSummary,
  buildRepairCandidateTitle,
  buildSuggestedRepairPatch,
  classifyCapabilityGapStrategy,
  classifyReplayCauseStrategy,
  improvementStrategyRationale,
  mapCapabilityGapEventRow,
  mapRepairCandidateRow,
  normalizeCapabilityGapCauseClass,
  normalizeRecoveryOptions,
  normalizeRepairValidationStatus,
  normalizeReplayStatus,
  toCapabilityGapEventRow,
  toCapabilityGapEventRows,
  toRepairCandidateRow,
  toRepairCandidateRows,
  type CapabilityGapEventRow,
  type RepairCandidateRow,
} from "./improvement-capability-gaps.js";
import { classifyCapabilityGapFromTrace } from "./capability-gap-classifier.js";
import { EvidenceEnvelopeService, sha256, stableStringify } from "./evidence-envelope-service.js";
import {
  listMcpTemplateDiscovery,
  runMcpServerHealthCheck,
  type McpDiagnosticsHost,
} from "./mcp-diagnostics-service.js";
import { listChatModelSuggestions } from "./chat-model-suggestions.js";
import {
  extractLearnedMemoryCandidates,
  hasProblematicBrowserRun,
  isQuestionLikeMemoryLine,
  looksLowConfidenceResponse,
  shouldExtractLearnedMemoryContent,
} from "./learned-memory-utils.js";

describe("gateway service coverage helpers", () => {
  it("maps capability gap rows, defaults invalid values, and normalizes recovery metadata", () => {
    const row: CapabilityGapEventRow = {
      event_id: "evt-1",
      session_id: "sess-1",
      turn_id: null,
      run_id: "run-1",
      cause_class: "skill_missing",
      failure_class: null,
      prompt_excerpt: "Need a spreadsheet import skill",
      prompt_ref: null,
      requested_tool: "skills.import",
      tool_family: "skills",
      tool_profile: "chat",
      policy_reason: null,
      provider_id: "openai",
      model: "gpt-test",
      config_area: "skills/catalog",
      suggested_repair_class: "skill_install_candidate",
      confidence: 2,
      repeat_count: 0,
      recovery_options_json: JSON.stringify(["install_skill", "install_skill", "unknown", "replay_failed_turn"]),
      replay_run_id: null,
      replay_status: "completed",
      repair_candidate_id: "cand-1",
      created_at: "2026-05-14T00:00:00.000Z",
      updated_at: "2026-05-14T00:00:01.000Z",
    };
    const mapped = mapCapabilityGapEventRow(row);

    expect(mapped).toMatchObject({
      eventId: "evt-1",
      sessionId: "sess-1",
      causeClass: "skill_missing",
      confidence: 1,
      repeatCount: 1,
      recoveryOptions: ["install_skill", "replay_failed_turn"],
      replayStatus: "completed",
      repairCandidateId: "cand-1",
    });
    expect(normalizeCapabilityGapCauseClass("not-real")).toBe("policy_denied_by_config");
    expect(normalizeReplayStatus("bogus")).toBe("not_run");
    expect(normalizeRepairValidationStatus("bogus")).toBe("not_started");
    expect(normalizeRecoveryOptions(["patch_config", "patch_config", "bad"])).toEqual(["patch_config"]);
    expect(toCapabilityGapEventRow(row)).toEqual(row);
    expect(toCapabilityGapEventRow({ ...row, confidence: "bad" })).toBeUndefined();
    expect(toCapabilityGapEventRows([row, { missing: true }])).toEqual([row]);
  });

  it("maps repair candidates and classifies repair strategy wording", () => {
    const row: RepairCandidateRow = {
      candidate_id: "cand-1",
      fingerprint: "skill_missing|skills.import||openai",
      cause_class: "unknown",
      title: "Missing skill capability for skills.import",
      summary: "One recurring event.",
      requested_tool: "skills.import",
      tool_profile: null,
      provider_id: "openai",
      config_area: "skills/catalog",
      suggested_patch: null,
      replay_run_id: null,
      validation_status: "passed",
      validation_summary: null,
      event_count: 0,
      confidence: -1,
      created_at: "2026-05-14T00:00:00.000Z",
      updated_at: "2026-05-14T00:00:01.000Z",
      last_seen_at: "2026-05-14T00:00:02.000Z",
    };
    const mapped = mapRepairCandidateRow(row);

    expect(mapped).toMatchObject({
      candidateId: "cand-1",
      causeClass: "policy_denied_by_config",
      eventCount: 1,
      confidence: 0,
      validationStatus: "passed",
    });
    expect(toRepairCandidateRow(row)).toEqual(row);
    expect(toRepairCandidateRow({ ...row, event_count: "bad" })).toBeUndefined();
    expect(toRepairCandidateRows([row, { missing: true }])).toEqual([row]);

    expect(classifyReplayCauseStrategy("tool_mismatch")).toBe("repair");
    expect(classifyReplayCauseStrategy("retrieval_miss")).toBe("harden");
    expect(classifyReplayCauseStrategy("other")).toBe("stabilize");
    expect(improvementStrategyRationale("repair")).toContain("replay-backed");
    expect(improvementStrategyRationale("harden")).toContain("guardrails");
    expect(improvementStrategyRationale("stabilize")).toContain("review artifacts");

    const strategyCases: Array<[CapabilityGapCauseClass, string]> = [
      ["retryable_network_failure", "repair"],
      ["skill_missing", "repair"],
      ["tool_exists_but_not_in_profile", "harden"],
      ["tool_requires_approval_but_not_exposed", "harden"],
      ["provider_tool_mismatch", "harden"],
      ["policy_denied_by_config", "harden"],
      ["missing_required_tool_evidence", "stabilize"],
      ["routing_profile_mismatch", "stabilize"],
    ];
    expect(strategyCases.map(([cause]) => classifyCapabilityGapStrategy(cause))).toEqual(
      strategyCases.map(([, tag]) => tag),
    );
  });

  it("builds capability repair fingerprints, titles, summaries, and review-only patch drafts", () => {
    expect(
      buildCapabilityGapFingerprint({
        causeClass: "tool_exists_but_not_in_profile",
        requestedTool: " Browser.Search ",
        toolProfile: " Chat ",
        providerId: " OpenAI ",
      }),
    ).toBe("tool_exists_but_not_in_profile|browser.search|chat|openai");

    const titleCases: CapabilityGapCauseClass[] = [
      "tool_exists_but_not_in_profile",
      "tool_requires_approval_but_not_exposed",
      "skill_missing",
      "provider_tool_mismatch",
      "retryable_network_failure",
      "missing_required_tool_evidence",
      "routing_profile_mismatch",
      "policy_denied_by_config",
    ];
    expect(titleCases.map((cause) => buildRepairCandidateTitle(cause, "browser.search"))).toEqual([
      "Tool approval mismatch for browser.search",
      "Approval path missing for browser.search",
      "Missing skill capability for browser.search",
      "Provider/tool mismatch for browser.search",
      "Retryable network failure for browser.search",
      "Missing tool evidence for browser.search",
      "Routing/profile mismatch for browser.search",
      "Config policy block for browser.search",
    ]);
    expect(
      buildRepairCandidateSummary({
        causeClass: "provider_tool_mismatch",
        requestedTool: "browser.search",
        toolProfile: "chat",
        providerId: "openai",
        configArea: "config/assistant.config.json",
        eventCount: 2,
      }),
    ).toBe(
      "2 recurring events detected \u00b7 tool browser.search \u00b7 profile chat \u00b7 provider openai \u00b7 config config/assistant.config.json. Validate with replay before apply.",
    );
    expect(buildSuggestedRepairPatch({ causeClass: "skill_missing" })).toBeUndefined();
    expect(
      buildSuggestedRepairPatch({
        causeClass: "tool_exists_but_not_in_profile",
        requestedTool: "browser.search",
        toolProfile: "chat",
        configArea: "config/tool-policy.json",
      }),
    ).toContain("allow browser.search");
    expect(
      buildSuggestedRepairPatch({
        causeClass: "tool_requires_approval_but_not_exposed",
        requestedTool: "browser.search",
        configArea: "config/tool-policy.json",
      }),
    ).toContain("approval-required path");
    expect(
      buildSuggestedRepairPatch({
        causeClass: "skill_missing",
        configArea: "skills/catalog",
      }),
    ).toContain("installable source");
    expect(
      buildSuggestedRepairPatch({
        causeClass: "provider_tool_mismatch",
        configArea: "config/assistant.config.json",
      }),
    ).toContain("minimal config-only repair");
  });

  it("classifies capability gaps from trace failures and upgrade suggestions", () => {
    const baseTrace = {
      toolRuns: [],
      routing: {},
    };

    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          failure: { failureClass: "approval_required", message: "approval needed" },
        } as never,
      }),
    ).toMatchObject({ causeClass: "tool_requires_approval_but_not_exposed" });
    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          capabilityUpgradeSuggestions: [{ recommendedAction: "switch_tool_profile" }],
        } as never,
      }),
    ).toMatchObject({ causeClass: "tool_exists_but_not_in_profile", confidence: 0.93 });
    expect(
      classifyCapabilityGapFromTrace({
        trace: baseTrace as never,
        suggestions: [{ kind: "skill_import" }],
      }),
    ).toMatchObject({ causeClass: "skill_missing" });
    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          failure: { message: "Missing required tool evidence from file.read" },
        } as never,
      }),
    ).toMatchObject({ causeClass: "missing_required_tool_evidence" });
    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          routing: { fallbackReason: "provider/tool mismatch: model does not support tool calls" },
        } as never,
      }),
    ).toMatchObject({ causeClass: "provider_tool_mismatch" });
    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          failure: { failureClass: "provider_timeout", message: "timed out" },
        } as never,
      }),
    ).toMatchObject({ causeClass: "retryable_network_failure" });
    expect(
      classifyCapabilityGapFromTrace({
        trace: {
          ...baseTrace,
          toolRuns: [{ status: "blocked", error: "policy denied" }],
          failure: { failureClass: "tool_blocked" },
        } as never,
      }),
    ).toMatchObject({ causeClass: "policy_denied_by_config" });
    expect(classifyCapabilityGapFromTrace({ trace: baseTrace as never })).toBeNull();
  });

  it("creates evidence envelopes with stable hashes, redaction, signatures, and realtime metadata", () => {
    const created: unknown[] = [];
    const publishRealtime = vi.fn();
    const storage = {
      evidenceEnvelopes: {
        latest: vi.fn(() => created.at(-1)),
        create: vi.fn((input) => {
          const envelope = { ...input };
          created.push(envelope);
          return envelope;
        }),
        list: vi.fn((query) => created.map((item) => ({ ...(item as Record<string, unknown>), query }))),
      },
    };
    const service = new EvidenceEnvelopeService({
      storage: storage as never,
      signingKey: "signing-key",
      publishRealtime,
    });

    const envelope = service.createEnvelope({
      eventKind: "tool_call_completed",
      sessionId: "sess-1",
      toolCallHashes: [" hash-b ", "hash-a", "hash-a", ""],
      memoryLineage: ["memory-2", "memory-1"],
      metadata: {
        apiKey: "sk-testsecretvalue123456",
        nested: [{ bearer: "Bearer tokenvalue1234567890" }, { safe: "visible" }],
      },
      createdAt: "2026-05-14T00:00:00.000Z",
    });
    const second = service.createEnvelope({
      eventKind: "approval_resolved",
      sessionId: "sess-1",
      createdAt: "2026-05-14T00:00:01.000Z",
    });

    expect(envelope).toMatchObject({
      eventKind: "tool_call_completed",
      toolCallHashes: ["hash-a", "hash-b"],
      memoryLineage: ["memory-1", "memory-2"],
      signatureStatus: "signed_hmac",
      metadata: {
        apiKey: "[redacted]",
        nested: [{ bearer: "[redacted]" }, { safe: "visible" }],
      },
    });
    expect(second.previousEnvelopeHash).toBe(envelope.contentHash);
    expect(service.listEnvelopes({ sessionId: "sess-1" })[0]).toMatchObject({ sessionId: "sess-1" });
    expect(publishRealtime).toHaveBeenCalledWith(
      "evidence_envelope_recorded",
      "runtime",
      expect.objectContaining({ envelopeId: envelope.envelopeId, signatureStatus: "signed_hmac" }),
    );
    expect(stableStringify({ b: 2, a: [1, undefined], c: undefined })).toBe('{"a":[1,],"b":2}');
    expect(sha256("abc")).toHaveLength(64);
  });

  it("reports MCP template readiness and server health from host checks", () => {
    const reports: unknown[] = [];
    const host: McpDiagnosticsHost = {
      requireFeatureEnabled: vi.fn(),
      listMcpTemplates: vi.fn(
        () =>
          [
            {
              templateId: "stdio-missing",
              label: "Stdio Missing",
              transport: "stdio",
              command: " ",
              authType: "none",
              installed: false,
            },
            {
              templateId: "http-auth",
              label: "HTTP Auth",
              transport: "http",
              url: "https://mcp.example.test",
              authType: "oauth",
              installed: true,
            },
            {
              templateId: "sse-ready",
              label: "SSE Ready",
              transport: "sse",
              url: "https://sse.example.test",
              authType: "none",
              installed: false,
            },
          ] as never,
      ),
      requireMcpServer: vi.fn(() => ({
        enabled: false,
        status: "connecting",
        transport: "stdio",
        command: "",
        policy: {
          blockedToolPatterns: [],
          allowedToolPatterns: [],
        },
      })),
      pickConnectorDiagnosticAction: vi.fn(() => "Configure command"),
      recordConnectorHealthRun: vi.fn((report) => reports.push(report)),
    };

    const discovery = listMcpTemplateDiscovery(host);
    expect(discovery.map((item) => item.readiness)).toEqual(["needs_command", "needs_auth", "ready"]);
    expect(discovery[0]?.dependencyChecks).toContainEqual(expect.objectContaining({ key: "command", status: "fail" }));

    const report = runMcpServerHealthCheck(host, "server-1");
    expect(report).toMatchObject({
      connectorType: "mcp_server",
      connectorId: "server-1",
      status: "error",
      recommendedNextAction: "Configure command",
    });
    expect(report.checks.map((check) => check.key)).toEqual(["enabled", "status", "command", "policy"]);
    expect(reports).toHaveLength(1);
  });

  it("suggests chat models from active provider defaults, templates, and remote listings", async () => {
    const listLlmModels = vi.fn(async (providerId?: string) => {
      if (providerId === "custom-active") {
        return [{ id: "remote-exact" }, { id: "remote-extra" }, { id: "remote-exact" }];
      }
      throw new Error("unexpected provider");
    });
    const suggestions = await listChatModelSuggestions(
      {
        getRuntime: () => ({
          activeProviderId: "custom-active",
          activeModel: "active-model",
          providers: [
            { providerId: "z-provider", label: "Zed", defaultModel: "zed-default" },
            { providerId: "custom-active", label: "Active", defaultModel: "default-model" },
          ],
        }),
        listLlmModels,
      },
      "model",
      3,
    );

    expect(suggestions).toEqual([
      { providerId: "custom-active", providerLabel: "Active", model: "active-model" },
      { providerId: "custom-active", providerLabel: "Active", model: "default-model" },
    ]);
    expect(listLlmModels).toHaveBeenCalledWith("custom-active");

    await expect(
      listChatModelSuggestions(
        {
          getRuntime: () => ({
            activeProviderId: "custom-active",
            activeModel: "active-model",
            providers: [{ providerId: "custom-active", label: "Active", defaultModel: "default-model" }],
          }),
          listLlmModels: vi.fn(async () => {
            throw new Error("offline");
          }),
        },
        "",
        1,
      ),
    ).resolves.toEqual([{ providerId: "custom-active", providerLabel: "Active", model: "active-model" }]);
  });

  it("filters low-confidence learned memory and extracts bounded candidate types", () => {
    expect(shouldExtractLearnedMemoryContent("", { role: "user", sourceRef: "msg-1" })).toBe(false);
    expect(
      shouldExtractLearnedMemoryContent("Remember to keep reports concise.", { role: "user", sourceRef: "msg-1" }),
    ).toBe(true);
    expect(
      shouldExtractLearnedMemoryContent("This assistant answer is detailed enough to be considered for memory.", {
        role: "assistant",
        sourceRef: "msg-2",
        trace: { status: "waiting_for_approval", toolRuns: [] },
      }),
    ).toBe(false);
    expect(
      shouldExtractLearnedMemoryContent("I hit a tool issue repeatedly and could not verify the answer.", {
        role: "assistant",
        sourceRef: "msg-3",
        trace: { status: "completed", toolRuns: [] },
      }),
    ).toBe(false);

    const failedBrowserRun = {
      toolName: "browser.search",
      status: "completed",
      result: { fallbackChain: [{ status: "failed", browserFailureClass: "remote_blocked" }] },
    } as ChatToolRunRecord;
    expect(hasProblematicBrowserRun([failedBrowserRun])).toBe(true);
    expect(
      shouldExtractLearnedMemoryContent("The verified result is long enough but browser evidence failed.", {
        role: "assistant",
        sourceRef: "msg-4",
        trace: { status: "completed", toolRuns: [failedBrowserRun] },
      }),
    ).toBe(false);
    expect(looksLowConfidenceResponse("I don't know")).toBe(true);
    expect(isQuestionLikeMemoryLine("Should we store this?")).toBe(true);
    expect(isQuestionLikeMemoryLine("Store this as a stable preference.")).toBe(false);

    const candidates = extractLearnedMemoryCandidates(
      [
        "Remember to use terse summaries.",
        "Top priority is release readiness.",
        "Never overwrite user edits without consent.",
        "GoatCitadel uses prompt pack regression gates.",
        "The release branch is frozen.",
        "Should this question be ignored?",
      ].join("\n"),
      "user",
    );
    expect(candidates.map((candidate) => candidate.itemType)).toEqual([
      "preference",
      "goal",
      "constraint",
      "project_context",
      "fact",
    ]);
    expect(candidates.every((candidate) => candidate.confidence <= 1 && candidate.confidence >= 0)).toBe(true);
  });

  it("covers alternate helper branches without changing runtime decisions", async () => {
    expect(toCapabilityGapEventRow(null)).toBeUndefined();
    expect(toCapabilityGapEventRows({ not: "an array" })).toEqual([]);
    expect(toRepairCandidateRow(null)).toBeUndefined();
    expect(toRepairCandidateRows({ not: "an array" })).toEqual([]);

    const created: unknown[] = [];
    const storage = {
      evidenceEnvelopes: {
        latest: vi.fn(() => undefined),
        create: vi.fn((input) => {
          const envelope = { ...input };
          created.push(envelope);
          return envelope;
        }),
        list: vi.fn(() => created),
      },
    };
    vi.stubEnv("GOATCITADEL_EVIDENCE_SIGNING_KEY", "");
    const unsignedEnvelope = new EvidenceEnvelopeService({ storage: storage as never }).createEnvelope({
      eventKind: "memory_lineage_updated",
      sessionId: "sess-unsigned",
      metadata: {
        maybeNull: null,
        safe: "plain text",
      },
    });
    vi.unstubAllEnvs();
    expect(unsignedEnvelope).toMatchObject({
      signatureStatus: "unsigned_local",
      signature: undefined,
      metadata: {
        maybeNull: null,
        safe: "plain text",
      },
    });
    expect(unsignedEnvelope.createdAt).toEqual(expect.any(String));
    expect(stableStringify(null)).toBe("null");

    const httpHost: McpDiagnosticsHost = {
      requireFeatureEnabled: vi.fn(),
      listMcpTemplates: vi.fn(
        () =>
          [
            {
              templateId: "http-warn",
              label: "HTTP Warn",
              transport: "http",
              url: "",
              authType: "none",
              installed: false,
            },
          ] as never,
      ),
      requireMcpServer: vi.fn(() => ({
        enabled: true,
        status: "connected",
        transport: "http",
        url: "https://mcp.example.test",
        policy: {
          blockedToolPatterns: ["danger.*"],
          allowedToolPatterns: [],
        },
      })),
      pickConnectorDiagnosticAction: vi.fn(() => undefined),
      recordConnectorHealthRun: vi.fn(),
    };
    expect(listMcpTemplateDiscovery(httpHost)[0]).toMatchObject({
      readiness: "needs_url",
      dependencyChecks: expect.arrayContaining([
        expect.objectContaining({ key: "url", status: "warn" }),
        expect.objectContaining({ key: "auth", status: "pass" }),
      ]),
    });
    expect(runMcpServerHealthCheck(httpHost, "http-ok")).toMatchObject({
      status: "ok",
      checks: expect.arrayContaining([
        expect.objectContaining({ key: "url", status: "pass" }),
        expect.objectContaining({ key: "policy", status: "pass" }),
      ]),
    });

    const modelSuggestions = await listChatModelSuggestions(
      {
        getRuntime: () => ({
          activeProviderId: "active",
          activeModel: "same-model",
          providers: [
            { providerId: "alpha", label: "Alpha", defaultModel: "same-model" },
            { providerId: "active", label: "Active", defaultModel: "remote-start" },
          ],
        }),
        listLlmModels: vi.fn(async () => [{ id: "remote-exact" }, { id: "remote-start-pro" }]),
      },
      "remote-start",
      10,
    );
    expect(modelSuggestions.map((item) => item.model)).toEqual(["remote-start", "remote-start-pro"]);
    await expect(
      listChatModelSuggestions(
        {
          getRuntime: () => ({
            activeProviderId: "active",
            providers: [
              { providerId: "alpha", label: "Alpha", defaultModel: "same-model" },
              { providerId: "active", label: "Active", defaultModel: "same-model" },
            ],
          }),
          listLlmModels: vi.fn(async () => []),
        },
        "",
        10,
      ),
    ).resolves.toEqual([{ providerId: "active", providerLabel: "Active", model: "same-model" }]);
    await expect(
      listChatModelSuggestions(
        {
          getRuntime: () => ({
            activeProviderId: "active",
            providers: [{ providerId: "active", label: "Active", defaultModel: "remote-exact" }],
          }),
          listLlmModels: vi.fn(async () => [{ id: "remote-extra" }]),
        },
        "remote-exact",
        10,
      ),
    ).resolves.toEqual([{ providerId: "active", providerLabel: "Active", model: "remote-exact" }]);

    expect(
      shouldExtractLearnedMemoryContent("This assistant answer is detailed and has clean evidence for extraction.", {
        role: "assistant",
        sourceRef: "msg-clean",
        trace: { status: "completed", toolRuns: [] },
      }),
    ).toBe(true);
    expect(looksLowConfidenceResponse("   ")).toBe(true);
    expect(isQuestionLikeMemoryLine("   ")).toBe(false);
    expect(hasProblematicBrowserRun([{ toolName: "file.read", status: "completed" } as ChatToolRunRecord])).toBe(false);
    expect(hasProblematicBrowserRun([{ toolName: "browser.search", status: "failed" } as ChatToolRunRecord])).toBe(
      true,
    );
    expect(hasProblematicBrowserRun([{ toolName: "http.get", status: "blocked" } as ChatToolRunRecord])).toBe(true);
    expect(
      hasProblematicBrowserRun([
        { toolName: "browser.search", status: "completed", result: "not-an-object" } as ChatToolRunRecord,
      ]),
    ).toBe(false);
    expect(
      hasProblematicBrowserRun([
        {
          toolName: "browser.search",
          status: "completed",
          result: { browserFailureClass: "http_error" },
        } as ChatToolRunRecord,
      ]),
    ).toBe(true);
    expect(
      hasProblematicBrowserRun([
        {
          toolName: "browser.search",
          status: "completed",
          result: { fallbackChain: null },
        } as ChatToolRunRecord,
      ]),
    ).toBe(false);
    expect(
      hasProblematicBrowserRun([
        {
          toolName: "browser.search",
          status: "completed",
          result: { fallbackChain: [null, { status: "ok", browserFailureClass: "clean" }] },
        } as ChatToolRunRecord,
      ]),
    ).toBe(false);
    expect(
      extractLearnedMemoryCandidates(
        [
          "Remember assistant-preferred formatting.",
          "The roadmap objective is reliability.",
          "Never summarize without evidence.",
          "The prompt pack integration is active.",
          "The branch is frozen.",
        ].join("\n"),
        "assistant",
      ).map((candidate) => candidate.confidence),
    ).toEqual([0.6, 0.58, 0.56, 0.52, 0.48]);
  });
});
