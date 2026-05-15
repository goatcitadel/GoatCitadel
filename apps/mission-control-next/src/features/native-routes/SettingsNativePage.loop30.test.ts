// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  applyIntegrationDefaults,
  buildChatGptOAuthProviderDraft,
  clearStoredOpenAICodexOAuthFlow,
  buildProviderEditorDraft,
  collectDefinitionFieldHints,
  createEmptyPersonalityEditorDraft,
  createPersonalityEditorDraft,
  describeToolApprovalMode,
  descriptionForSettingsSection,
  deriveLlamaCppAlias,
  deriveSetupCenterItems,
  delay,
  formatCapabilities,
  formatCheckedAtLabel,
  formatDateTime,
  formatJson,
  formatOpenAICodexOAuthExpiry,
  formatPersonalityCategoryLabel,
  formatPersonalityStatus,
  formatProviderCredentialLabel,
  formatProviderProbeSourceMeta,
  formatProviderProbeStateLabel,
  labelForSettingsSection,
  getErrorMessage,
  isLikelyLocalProviderBaseUrl,
  isRuntimeInvokableMcpServer,
  isStoredOpenAICodexOAuthFlow,
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
  removeStoredOpenAICodexOAuthFlow,
  setupMeta,
  splitCommaList,
  splitLineList,
  wizardStateForChecklist,
  writeStoredOpenAICodexOAuthFlow,
} from "./SettingsNativePage";

describe("SettingsNativePage loop 30 branch matrices", () => {
  it("classifies setup, draft, and config helpers across empty and non-empty branches", () => {
    expect(readConnectionConfigString(undefined, "token")).toBeUndefined();
    expect(readConnectionConfigString({ token: " value " }, "token")).toBe("value");
    expect(readDraftString({ token: "" }, "token")).toBeUndefined();
    expect(readDraftString({ token: " token " }, "token")).toBe("token");
    expect(splitCommaList("a,, b ,")).toEqual(["a", "b"]);
    expect(splitLineList("one\r\n\ntwo")).toEqual(["one", "two"]);
    expect(parseJsonObject(" ", { fallback: true })).toEqual({ fallback: true });
    expect(() => parseJsonObject("null")).toThrow("JSON object");
    expect(formatJson({ ok: true })).toContain('"ok": true');

    expect(
      applyIntegrationDefaults({ fields: [{ key: "mode", defaultValue: "safe" }, { key: "unset" }] } as any, {}),
    ).toEqual({ mode: "safe" });
    expect(matchesToolGrant({ toolPattern: "browser.*" } as any, "browser.search")).toBe(true);
    expect(matchesToolGrant({ toolPattern: "browser.open" } as any, "browser.search")).toBe(false);
    expect(isRuntimeInvokableMcpServer({ transport: "stdio" })).toBe(true);
    expect(isRuntimeInvokableMcpServer({ transport: "http", url: " goatcitadel://approval-inbox " })).toBe(true);
    expect(isRuntimeInvokableMcpServer({ transport: "http", url: "https://example.test" })).toBe(false);

    expect(
      preferredChannelDefinition([{ catalog: { catalogId: "x" }, wizard: { steps: [] } }] as any)?.catalog.catalogId,
    ).toBe("x");
    expect(
      collectDefinitionFieldHints({
        wizard: { steps: [{ fields: [{ label: "A", explanation: "B", type: "text" }] }] },
      } as any),
    ).toEqual([{ label: "A", explanation: "B", type: "text" }]);

    expect(wizardStateForChecklist("complete" as any)).toBe("complete");
    expect(wizardStateForChecklist("needs_input" as any)).toBe("active");
    expect(wizardStateForChecklist("blocked" as any)).toBe("pending");
    expect(setupMeta("complete" as any)).toBe("Pass");
    expect(setupMeta("needs_input" as any)).toBe("Needs repair");
    expect(setupMeta(undefined)).toBe("Optional");
    expect(normalizeToolApprovalMode("bypass")).toBe("bypass");
    expect(normalizeToolApprovalMode(undefined)).toBe("approve_risky");
    expect(normalizeBudgetMode("power")).toBe("power");
    expect(normalizeBudgetMode("bad")).toBe("balanced");

    const setupDescriptions = deriveSetupCenterItems({
      checklist: [{ id: "runtime", status: "needs_input", detail: "Start runtime." }],
      settings: {
        auth: { mode: "none" },
        budgetMode: "balanced",
        llm: { activeModel: "", providers: [{ hasApiKey: false }] },
      },
    } as any).map((item) => item.description);
    expect(setupDescriptions).toEqual(expect.arrayContaining(["Start runtime."]));
  });

  it("covers provider, OAuth, local runtime, and personality helper branches", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    const flow = {
      providerId: "openai-codex" as const,
      flowId: "flow-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-123",
      expiresAt: "2026-05-15T12:05:00.000Z",
      pollAfterMs: 2000,
    };

    expect(buildChatGptOAuthProviderDraft().providerId).toBe("openai-codex");
    expect(buildProviderEditorDraft(null).providerId).toBe("");
    expect(buildProviderEditorDraft({ providerId: "local", label: "Local", apiStyle: "unknown" } as any).apiStyle).toBe(
      "unknown",
    );
    expect(isTrustedOpenAICodexVerificationUrl("https://auth.openai.com/activate")).toBe(true);
    expect(isTrustedOpenAICodexVerificationUrl("http://openai.com/activate")).toBe(false);
    expect(normalizeOpenAICodexPollDelayMs(250)).toBe(1000);
    expect(normalizeOpenAICodexPollDelayMs(180_000)).toBe(180_000);
    expect(isStoredOpenAICodexOAuthFlow(flow)).toBe(true);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, verificationUrl: "https://evil.test" })).toBe(false);
    expect(formatOpenAICodexOAuthExpiry(flow)).toBe("5 minutes");

    expect(isLikelyLocalProviderBaseUrl("http://172.31.1.5:11434")).toBe(true);
    expect(isLikelyLocalProviderBaseUrl("https://api.openai.com")).toBe(false);
    expect(formatProviderProbeStateLabel("ready")).toBe("Verified");
    expect(formatProviderProbeStateLabel("error")).toBe("Unreachable");
    expect(formatProviderProbeSourceMeta({ modelProbeSource: "error_fallback", modelProbeWarning: "" })).toBe(
      "Fallback after probe error",
    );
    expect(formatCheckedAtLabel("bad")).toBe("Last check unavailable");
    expect(formatProviderCredentialLabel("openai-codex", false, { requiresReauth: true } as any)).toBe("OAuth reauth");
    expect(formatProviderCredentialLabel("openai", false, null)).toBe("secret missing");
    expect(formatCapabilities({ voiceInput: true, voiceOutput: false, artifacts: true })).toBe("voiceInput, artifacts");

    expect(deriveLlamaCppAlias("C:\\models\\model.gguf")).toBe("model");
    expect(getErrorMessage("not an error")).toBe("Something went wrong.");
    expect(formatDateTime(null)).toBe("Unknown");
    expect(formatPersonalityCategoryLabel("research_assistant" as any)).toBe("Research Assistant");
    expect(normalizePersonalityEditorId("  Hello World! ")).toBe("hello-world");
    expect(
      personalityDraftToMutationInput({
        id: "",
        label: " Label ",
        category: "core",
        description: " Desc ",
        tone: " Direct ",
        style: " Tight ",
        systemOverlay: " Overlay ",
        safetyNotes: "one\n\ntwo",
      } as any),
    ).toMatchObject({ label: "Label", safetyNotes: ["one", "two"] });
    expect(
      formatPersonalityStatus({ builtin: true, modified: true, id: "default", editable: false } as any, "default"),
    ).toBe("Built-in · Modified · Chat default · Locked");
  });

  it("removes invalid stored OAuth flows without trusting broken storage APIs", () => {
    const removed: string[] = [];
    const badJsonStorage = {
      getItem: vi.fn(() => "{bad-json"),
      removeItem: vi.fn((key: string) => removed.push(key)),
    } as unknown as Storage;
    expect(readStoredOpenAICodexOAuthFlowFrom(badJsonStorage)).toBeNull();
    expect(removed).toHaveLength(1);
    removeStoredOpenAICodexOAuthFlow(badJsonStorage);
    expect(removed).toHaveLength(2);

    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    } as unknown as Storage;
    expect(readStoredOpenAICodexOAuthFlowFrom(throwingStorage)).toBeNull();
    expect(() => removeStoredOpenAICodexOAuthFlow(throwingStorage)).not.toThrow();
  });

  it("covers remaining settings helper defaults without changing UI behavior", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    const stored: Record<string, string> = {};
    const storage = {
      getItem: vi.fn((key: string) => stored[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        stored[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete stored[key];
      }),
    } as unknown as Storage;
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);

    const flow = {
      providerId: "openai-codex" as const,
      flowId: "flow-loop31",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-31",
      expiresAt: "2026-05-15T11:59:00.000Z",
      pollAfterMs: 500,
    };
    writeStoredOpenAICodexOAuthFlow(flow);
    expect(storage.setItem).toHaveBeenCalled();
    expect(readStoredOpenAICodexOAuthFlowFrom(storage)).toBeNull();
    clearStoredOpenAICodexOAuthFlow();
    expect(storage.removeItem).toHaveBeenCalled();

    expect(describeToolApprovalMode("approve_all")).toBe("Ask every time");
    expect(describeToolApprovalMode("approve_risky")).toBe("Ask for risky work");
    expect(describeToolApprovalMode("bypass")).toBe("Bypass prompts");
    expect(labelForSettingsSection("providers")).toBe("Providers");
    expect(labelForSettingsSection("unknown")).toBe("Unknown");
    expect(descriptionForSettingsSection("channels")).toContain("channel connections");
    expect(descriptionForSettingsSection("unknown")).toContain("not registered");
    expect(formatCapabilities({})).toBe("No advertised capabilities");
    expect(formatCheckedAtLabel(undefined)).toBe("Not checked yet");
    expect(formatProviderProbeSourceMeta({})).toBe("Not checked yet");
    expect(formatProviderCredentialLabel("openai", true, null)).toBe("secret ready");
    expect(formatProviderProbeStateLabel("fallback")).toBe("Suggested");
    expect(formatProviderProbeStateLabel("empty")).toBe("No models");
    expect(formatProviderProbeStateLabel("unknown" as never)).toBe("Not checked");
    expect(formatOpenAICodexOAuthExpiry(null)).toBeNull();
    expect(formatOpenAICodexOAuthExpiry(flow)).toBe("1 minute");
    expect(normalizeOpenAICodexPollDelayMs("bad")).toBe(5000);
    expect(isStoredOpenAICodexOAuthFlow({ ...flow, providerId: "openai" })).toBe(false);
    expect(isTrustedOpenAICodexVerificationUrl("not a url")).toBe(false);
    expect(deriveLlamaCppAlias("")).toBe("");

    expect(createEmptyPersonalityEditorDraft()).toMatchObject({ id: "", label: "", category: "core" });
    expect(createPersonalityEditorDraft(null)).toMatchObject({ id: "", label: "" });
    expect(
      createPersonalityEditorDraft({
        id: "analyst",
        label: "Analyst",
        category: "research_assistant",
        description: "Research",
        tone: "precise",
        style: "brief",
        systemOverlay: "overlay",
        safetyNotes: ["cite sources"],
      } as any),
    ).toMatchObject({ id: "analyst", safetyNotes: "cite sources" });
    expect(personalityDraftToMutationInput({ ...createEmptyPersonalityEditorDraft(), label: "New" })).toMatchObject({
      label: "New",
      safetyNotes: ["Personality overlays never override safety, privacy, approval, tool, memory, or skill policies."],
    });
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
