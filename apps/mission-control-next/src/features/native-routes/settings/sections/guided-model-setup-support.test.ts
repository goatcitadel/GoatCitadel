import { describe, expect, it } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  activeGuidedSetupPlans,
  clampGuidedThinkingLevel,
  GUIDED_CATALOG_LOADING_READINESS,
  groupGuidedProviders,
  guidedConnectionHint,
  guidedProviderOptionLabel,
  pendingPlanForSelection,
  withAddableBuiltinProviders,
  localRuntimeSetupGuide,
  mergePlansByRevision,
  reconcileGuidedPlanRead,
  pickDefaultGuidedProvider,
  resolveGuidedProviderReadiness,
  submittedGuidedSelection,
  supportedGuidedThinkingLevels,
  withHeldPlan,
} from "./guided-model-setup-support";

const LOCAL_RUNTIME = {
  providerId: "llamacpp",
  label: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  hasApiKey: false,
  localCostPosture: "zero_cost_local_runtime" as const,
};
const CLOUD_PROVIDER = {
  providerId: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
};

describe("guided provider readiness", () => {
  it("does not treat a local runtime as ready before its endpoint answers a live probe", () => {
    expect(resolveGuidedProviderReadiness({ ...LOCAL_RUNTIME, modelProbeState: "not_checked" }).state).toBe("checking");
    const unreachable = resolveGuidedProviderReadiness({
      ...LOCAL_RUNTIME,
      modelProbeState: "fallback",
      modelProbeSource: "error_fallback",
      modelProbeWarning: "llama.cpp runtime is disabled in assistant config",
    });
    expect(unreachable).toMatchObject({ state: "not_verified", label: "Not verified" });
    expect(unreachable.description).toContain("http://127.0.0.1:8080/v1");
    expect(unreachable.description).toContain("llama.cpp runtime is disabled in assistant config");
    expect(
      resolveGuidedProviderReadiness({ ...LOCAL_RUNTIME, modelProbeState: "empty", modelProbeSource: "live" }).state,
    ).toBe("not_verified");
  });

  it("marks a local runtime ready only from live endpoint evidence", () => {
    expect(
      resolveGuidedProviderReadiness({
        ...LOCAL_RUNTIME,
        modelProbeState: "ready",
        modelProbeSource: "live",
        modelRefreshStatus: "fresh",
      }),
    ).toMatchObject({ state: "ready", evidence: "local_endpoint" });
    const stale = resolveGuidedProviderReadiness({
      ...LOCAL_RUNTIME,
      modelProbeState: "ready",
      modelProbeSource: "live",
      modelRefreshStatus: "stale",
    });
    expect(stale).toMatchObject({ state: "not_verified", evidence: null });
    expect(stale.description).toContain("stale");
  });

  it("uses the Gateway's credential readiness for cloud providers", () => {
    expect(resolveGuidedProviderReadiness({ ...CLOUD_PROVIDER, hasApiKey: true })).toMatchObject({
      state: "ready",
      evidence: "credential",
    });
    expect(resolveGuidedProviderReadiness({ ...CLOUD_PROVIDER, hasApiKey: false }).state).toBe("needs_setup");
    expect(
      resolveGuidedProviderReadiness({
        ...CLOUD_PROVIDER,
        hasApiKey: true,
        authReadiness: { status: "invalid", source: "env", liveVerified: false, reasonCode: "credential_rejected" },
      }).state,
    ).toBe("needs_setup");
    expect(
      resolveGuidedProviderReadiness({
        ...CLOUD_PROVIDER,
        authReadiness: { status: "unknown", source: "none", liveVerified: false, reasonCode: "owner_unavailable" },
      }).state,
    ).toBe("not_verified");
    expect(resolveGuidedProviderReadiness(CLOUD_PROVIDER).state).toBe("not_verified");
  });

  it("asks for a choice when no provider is selected", () => {
    expect(resolveGuidedProviderReadiness(null)).toMatchObject({ state: "needs_setup", label: "Not chosen" });
  });
});

describe("guided default provider", () => {
  const withKey = { ...CLOUD_PROVIDER, providerId: "anthropic", label: "Anthropic", hasApiKey: true };
  const withoutKey = { ...CLOUD_PROVIDER, hasApiKey: false };

  it("keeps the saved default provider", () => {
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withKey], "llamacpp")?.providerId).toBe("llamacpp");
  });

  it("prefers a provider with ready evidence and never an unverified local runtime", () => {
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withoutKey, withKey], "")?.providerId).toBe("anthropic");
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withoutKey], "")).toBeNull();
    expect(
      pickDefaultGuidedProvider(
        [
          { ...LOCAL_RUNTIME, modelProbeState: "ready", modelProbeSource: "live", modelRefreshStatus: "fresh" },
          withoutKey,
        ],
        "",
      )?.providerId,
    ).toBe("llamacpp");
    expect(
      pickDefaultGuidedProvider(
        [
          { ...LOCAL_RUNTIME, modelProbeState: "ready", modelProbeSource: "live", modelRefreshStatus: "stale" },
          withoutKey,
        ],
        "",
      ),
    ).toBeNull();
  });
});

describe("guided model setup support", () => {
  it("limits effort to Off when the provider reports no reasoning", () => {
    expect(supportedGuidedThinkingLevels({ reasoning: false } as never)).toEqual(["off"]);
  });

  it("maps provider reasoning efforts onto thinking levels and always keeps Off", () => {
    expect(
      supportedGuidedThinkingLevels({ reasoning: true, reasoningEfforts: ["low", "medium", "high"] } as never),
    ).toEqual(["off", "minimal", "standard", "extended"]);
  });

  it("offers every level when capabilities are unknown", () => {
    expect(supportedGuidedThinkingLevels(undefined)).toHaveLength(7);
  });

  it("clamps to the strongest supported level at or below the request", () => {
    expect(clampGuidedThinkingLevel("deep", ["off", "minimal", "standard"])).toBe("standard");
    expect(clampGuidedThinkingLevel("standard", ["off"])).toBe("off");
    expect(clampGuidedThinkingLevel("extended", ["off", "minimal", "standard", "extended"])).toBe("extended");
  });

  it("treats the draft captured at submission as the saved submission when its effort clamps to the saved one", () => {
    const saved = { providerId: "claude-code-cli", model: "sonnet", thinkingLevel: "off" as const };
    const draft = { ...saved, thinkingLevel: "standard" as const };
    expect(submittedGuidedSelection(draft, saved, ["off"])).toBe(draft);
    expect(submittedGuidedSelection(draft, saved, ["off", "minimal", "standard"])).toBe(saved);
    expect(submittedGuidedSelection({ ...draft, providerId: "openai" }, saved, ["off"])).toBe(saved);
    // A plan this wizard did not submit, such as one resumed from the Gateway, acknowledges only the saved value.
    expect(submittedGuidedSelection(null, saved, ["off"])).toBe(saved);
  });

  it("returns setup guides only for llama.cpp and LocalAI, using the configured endpoint", () => {
    expect(
      localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "http://127.0.0.1:9000/v1" })?.steps.join(" "),
    ).toContain("http://127.0.0.1:9000/v1");
    expect(localRuntimeSetupGuide({ providerId: "localai", baseUrl: "http://127.0.0.1:8080/v1" })?.title).toBe(
      "Start LocalAI before connecting",
    );
    expect(localRuntimeSetupGuide({ providerId: "openai", baseUrl: "https://api.openai.com/v1" })).toBeNull();
    expect(localRuntimeSetupGuide(null)).toBeNull();
  });

  it("uses the chosen model and local endpoint in the llama.cpp command", () => {
    expect(
      localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "http://127.0.0.1:8181/v1" }, "Ornith-35B-Q4_K_M")
        ?.command,
    ).toBe("llama-server -m path/to/model.gguf --alias Ornith-35B-Q4_K_M --host 127.0.0.1 --port 8181 --jinja");
    expect(localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "not a url" })?.command).toBe(
      "llama-server -m path/to/model.gguf --alias my-local-model --host 127.0.0.1 --port 8080 --jinja",
    );
  });

  it("does not offer a copyable command when the model alias could execute shell text", () => {
    expect(
      localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1" }, "model;echo unsafe")
        ?.command,
    ).toBeUndefined();
  });
});

describe("guided connection hint", () => {
  it("keeps the ChatGPT sign-in copy for Codex OAuth", () => {
    expect(guidedConnectionHint({ authMode: "codex-oauth" })?.connectLabel).toBe("Connect ChatGPT");
  });

  it("tells Claude Code users to paste a setup-token and that Anthropic may reject it", () => {
    const hint = guidedConnectionHint({ authMode: "claude-code-oauth" });
    expect(hint?.connectLabel).toBe("Connect Claude Code");
    expect(hint?.note).toContain("claude setup-token");
    expect(hint?.note).toContain("may reject");
  });

  it("leaves API-key providers on the generic copy", () => {
    expect(guidedConnectionHint({ authMode: undefined })).toBeNull();
    expect(guidedConnectionHint(null)).toBeNull();
  });
});

describe("local Claude Code CLI login readiness", () => {
  const cli = (status: string, reasonCode?: string) => ({
    providerId: "claude-code-cli",
    label: "Claude Code CLI (local login)",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "claude-code-cli-login" as const,
    authReadiness: { status, source: "metadata", liveVerified: true, ...(reasonCode ? { reasonCode } : {}) },
  });

  it("is ready only from the login probe and never asks for a credential", () => {
    expect(resolveGuidedProviderReadiness(cli("ready", "claude_cli_logged_in") as never)).toMatchObject({
      state: "ready",
      evidence: "local_login",
    });
    const loggedOut = resolveGuidedProviderReadiness(cli("missing", "claude_cli_logged_out") as never);
    expect(loggedOut.state).toBe("needs_setup");
    expect(loggedOut.description).toContain("sign in with /login");
    expect(loggedOut.description).not.toContain("credential");
    expect(resolveGuidedProviderReadiness(cli("unknown", "claude_cli_not_probed") as never).state).toBe("not_verified");
    const readyWithOddReason = resolveGuidedProviderReadiness(cli("configured", "metadata_only") as never);
    expect(readyWithOddReason.state).toBe("ready");
    expect(readyWithOddReason.description).toContain("signed in");
    expect(readyWithOddReason.description).not.toContain("not found");
  });

  it("offers a login check and points the token route at the CLI provider", () => {
    expect(guidedConnectionHint({ authMode: "claude-code-cli-login" })?.connectLabel).toBe("Check Claude Code login");
    expect(guidedConnectionHint({ authMode: "claude-code-cli-login" })?.note).toContain("stores no token");
    expect(guidedConnectionHint({ authMode: "claude-code-oauth" })?.note).toContain("Claude Code CLI (local login)");
  });
});

describe("built-in providers an older config lacks", () => {
  const saved = {
    providerId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt",
    apiStyle: "openai-responses",
    models: [],
    sanitizedEndpointIdentity: "",
  };

  it("offers the Claude Code CLI provider with its template profile when the saved config lacks it", () => {
    const options = withAddableBuiltinProviders([saved] as never, true);
    const cli = options.find((option) => option.providerId === "claude-code-cli");
    expect(cli?.label).toBe("Claude Code CLI (local login) · not added yet");
    expect(cli?.addProfile).toMatchObject({
      label: "Claude Code CLI (local login)",
      apiStyle: "claude-code-cli",
      authMode: "claude-code-cli-login",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(resolveGuidedProviderReadiness(cli!)).toMatchObject({ state: "needs_setup" });
    expect(resolveGuidedProviderReadiness(cli!).description).toContain("not added to this installation yet");
    expect(guidedConnectionHint(cli!)?.connectLabel).toBe("Add Claude Code CLI");
  });

  it("adds nothing once the saved config has the provider", () => {
    const present = { ...saved, providerId: "claude-code-cli", label: "Claude Code CLI (local login)" };
    const options = withAddableBuiltinProviders([saved, present] as never, true);
    expect(options).toHaveLength(2);
    expect(options.some((option) => option.addProfile)).toBe(false);
  });
});

describe("pending setup plan reuse", () => {
  const anthropic = { planId: "a", request: { kind: "provider_connection", providerId: "anthropic" } } as never;
  const claude = { planId: "c", request: { kind: "provider_connection", providerId: "claude-code" } } as never;

  it("resumes the active plan for the selected provider from the whole list", () => {
    expect(pendingPlanForSelection([anthropic, claude], "claude-code")).toBe(claude);
    expect(pendingPlanForSelection([anthropic], "claude-code")).toBeNull();
  });

  it("resumes the first active plan when no provider is chosen yet", () => {
    expect(pendingPlanForSelection([anthropic, claude], "")).toBe(anthropic);
    expect(pendingPlanForSelection([], "anthropic")).toBeNull();
  });
});

describe("pending setup plan reuse by kind and model", () => {
  const connect = { planId: "k", request: { kind: "provider_connection", providerId: "test" } } as never;
  const modelA = {
    planId: "m",
    request: { kind: "installation_default_model", providerId: "test", model: "a" },
  } as never;

  it("does not reopen a connection plan when the default-model plan is wanted", () => {
    expect(pendingPlanForSelection([connect], "test", { kind: "installation_default_model", model: "a" })).toBeNull();
  });

  it("does not reuse a default-model plan for a different model", () => {
    expect(pendingPlanForSelection([modelA], "test", { kind: "installation_default_model", model: "b" })).toBeNull();
  });

  it("does not reuse a default-model plan for a different thinking level", () => {
    expect(
      pendingPlanForSelection([modelA], "test", {
        kind: "installation_default_model",
        model: "a",
        thinkingLevel: "high",
      }),
    ).toBeNull();
  });

  it("reuses the default-model plan on an exact kind, model and level match", () => {
    expect(
      pendingPlanForSelection([connect, modelA], "test", {
        kind: "installation_default_model",
        model: "a",
        thinkingLevel: "standard",
      }),
    ).toBe(modelA);
  });
});

describe("addable built-in providers need a loaded catalog", () => {
  it("offers nothing while the catalog is loading or failed", () => {
    expect(withAddableBuiltinProviders([], false)).toEqual([]);
    expect(withAddableBuiltinProviders([], true).map((option) => option.providerId)).toEqual(["claude-code-cli"]);
  });
});

describe("finding the Claude Code CLI provider", () => {
  const option = (providerId: string) => ({
    providerId,
    label: providerId,
    baseUrl: "https://example.test",
    defaultModel: "m",
    apiStyle: "openai-responses",
    models: [],
    sanitizedEndpointIdentity: "",
  });

  it("lists the missing CLI provider right after the Claude Code token route, not at the end", () => {
    const ids = withAddableBuiltinProviders(
      [option("openai"), option("anthropic"), option("claude-code"), option("google"), option("ollama")] as never,
      true,
    ).map((entry) => entry.providerId);
    expect(ids).toEqual(["openai", "anthropic", "claude-code", "claude-code-cli", "google", "ollama"]);
  });

  it("falls back to right after Anthropic, then to the top", () => {
    expect(
      withAddableBuiltinProviders([option("openai"), option("anthropic"), option("google")] as never, true).map(
        (entry) => entry.providerId,
      ),
    ).toEqual(["openai", "anthropic", "claude-code-cli", "google"]);
    expect(withAddableBuiltinProviders([option("openai")] as never, true)[0]?.providerId).toBe("claude-code-cli");
  });

  it("offers a one-click switch from the token route to the CLI provider", () => {
    expect(guidedConnectionHint({ authMode: "claude-code-oauth" })?.alternative).toEqual({
      providerId: "claude-code-cli",
      label: "Use Claude Code CLI instead",
    });
    expect(guidedConnectionHint({ authMode: "codex-oauth" })?.alternative).toBeUndefined();
  });

  it("reports loading, not a missing provider, while the catalog loads", () => {
    expect(GUIDED_CATALOG_LOADING_READINESS).toMatchObject({ state: "checking", label: "Loading…" });
  });
});

describe("grouped provider choices", () => {
  const base = {
    baseUrl: "https://example.test",
    defaultModel: "m",
    apiStyle: "openai-responses",
    models: [],
    sanitizedEndpointIdentity: "",
  };
  const providers = [
    { ...base, providerId: "openai", label: "OpenAI" },
    {
      ...base,
      providerId: "openai-codex",
      label: "OpenAI Codex (ChatGPT OAuth)",
      authMode: "codex-oauth",
      hasApiKey: true,
    },
    { ...base, providerId: "anthropic", label: "Anthropic" },
    { ...base, providerId: "claude-code", label: "Claude Code (Claude subscription)", authMode: "claude-code-oauth" },
    { ...base, providerId: "vertex", label: "Google Vertex AI", authMode: "google-adc" },
    { ...base, providerId: "ollama", label: "Ollama", localCostPosture: "zero_cost_local_runtime" },
    { ...base, providerId: "npu-local", label: "NPU Local Sidecar", localCostPosture: "zero_cost_local_runtime" },
  ] as never;

  it("puts ready providers first, then subscriptions, API keys and local runtimes", () => {
    const groups = groupGuidedProviders(providers, ["openai-codex"]);
    expect(groups.map((group) => [group.label, group.providers.map((provider) => provider.providerId)])).toEqual([
      ["Ready to use", ["openai-codex"]],
      ["Use a subscription", ["claude-code"]],
      ["Pay-per-use API key", ["openai", "anthropic"]],
      ["Pay-per-use cloud account", ["vertex"]],
      ["Run locally", ["ollama"]],
    ]);
  });

  it("hides a retired provider unless it is the current selection", () => {
    const ids = (selected: string) =>
      groupGuidedProviders(providers, [selected]).flatMap((group) =>
        group.providers.map((provider) => provider.providerId),
      );
    expect(ids("openai-codex")).not.toContain("npu-local");
    expect(ids("npu-local")).toContain("npu-local");
  });

  it("keeps a saved retired provider visible after the draft selection moves away", () => {
    const visible = groupGuidedProviders(providers, ["openai-codex", "npu-local"]).flatMap((group) =>
      group.providers.map((provider) => provider.providerId),
    );
    expect(visible).toContain("npu-local");
  });

  it("names each option by how it is paid for", () => {
    expect(guidedProviderOptionLabel({ providerId: "anthropic", label: "Anthropic" })).toBe(
      "Anthropic API (Console key)",
    );
    expect(guidedProviderOptionLabel({ providerId: "openai", label: "OpenAI" })).toBe("OpenAI API (platform key)");
    expect(guidedProviderOptionLabel({ providerId: "claude-code", label: "Claude Code (Claude subscription)" })).toBe(
      "Claude Code token (may be rejected)",
    );
    expect(guidedProviderOptionLabel({ providerId: "ollama", label: "Ollama" })).toBe("Ollama");
  });
});

describe("plan reads reconciled by revision", () => {
  const plan = (planId: string, revision: number, status: ChangePlanRecord["status"] = "awaiting_input") =>
    ({
      planId,
      revision,
      status,
      kind: "provider_connection",
      origin: { workspaceId: "default", surface: "settings" },
      request: { kind: "provider_connection", providerId: "test" },
    }) as unknown as ChangePlanRecord;

  it("keeps a held newer revision over an older fetched copy", () => {
    const held = plan("a", 3);
    expect(mergePlansByRevision([plan("a", 2)], [held])).toEqual([held]);
  });
  it("takes a fetched revision newer than the held one", () => {
    const fetched = plan("a", 4);
    expect(mergePlansByRevision([fetched], [plan("a", 3)])).toEqual([fetched]);
  });
  it("adds plans only the fetch lists and leaves out plans only held", () => {
    const fetched = plan("b", 1);
    expect(mergePlansByRevision([fetched], [plan("a", 3)])).toEqual([fetched]);
  });
  it("keeps a live plan recorded after the read started that the read leaves out, first", () => {
    const fetched = plan("b", 1);
    const created = plan("c", 1);
    expect(mergePlansByRevision([fetched], [plan("a", 3), created], [created])).toEqual([created, fetched]);
    expect(mergePlansByRevision([fetched], [plan("c", 2, "completed")], [plan("c", 2, "completed")])).toEqual([
      fetched,
    ]);
  });
  it("reconciles a read with only the live records made after it started", () => {
    const before = plan("a", 1);
    const created = plan("c", 1);
    expect(reconcileGuidedPlanRead([], [before], [before, created]).map((item) => item.planId)).toEqual(["c"]);
    expect(reconcileGuidedPlanRead([], [before, created], [before, created])).toEqual([]);
  });
  it("keeps a stale non-terminal copy out of the active list when the held newer plan is terminal", () => {
    const merged = mergePlansByRevision([plan("a", 2), plan("b", 1)], [plan("a", 3, "completed")]);
    expect(activeGuidedSetupPlans(merged).map((item) => item.planId)).toEqual(["b"]);
  });
  it("records a plan in place of an older held copy, but never over a newer one", () => {
    const other = plan("b", 1);
    expect(withHeldPlan([plan("a", 1), other], plan("a", 2))).toEqual([other, plan("a", 2)]);
    expect(withHeldPlan([plan("a", 3)], plan("a", 2))).toEqual([plan("a", 3)]);
  });
});
