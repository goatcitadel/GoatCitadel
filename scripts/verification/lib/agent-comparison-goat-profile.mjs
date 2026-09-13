// This profile seeds only a new comparison runtime. It never reads the operator's
// installed config, skills, workspaces, credentials, or databases.
export function goatComparisonConfig(profile, slots) {
  const thinking = { none: "off", low: "minimal", medium: "standard", high: "extended", xhigh: "deep" };
  if (!Object.hasOwn(thinking, profile.reasoning))
    throw new Error("GoatCitadel cannot represent this reasoning effort exactly.");
  const nativeTools = [
    ...(profile.tools.includes("files")
      ? ["fs.read", "fs.list", "fs.stat", "fs.write", "file.read_range", "file.find", "code.search"]
      : []),
    ...(profile.tools.includes("terminal") ? ["shell.exec"] : []),
  ];
  return {
    nativeTools,
    config: {
      version: 1,
      assistant: {
        environment: "local",
        deploymentProfile: "trusted_local",
        toolApprovalMode: "approve_risky",
        defaultToolProfile: "comparison",
        features: { autonomyV1Disabled: true },
        dataDir: "./data",
        transcriptsDir: "./data/transcripts",
        auditDir: "./data/audit",
        workspaceDir: slots.workspace,
        worktreesDir: "./worktrees",
        auth: { mode: "token", allowLoopbackBypass: false },
        memory: { enabled: false },
        approvalExplainer: { enabled: false },
        mesh: { enabled: false },
        npu: { enabled: false, autoStart: false },
        llamaCpp: { enabled: false, autoStart: false },
      },
      toolPolicy: {
        profiles: { comparison: nativeTools },
        tools: { profile: "comparison", approvalMode: "approve_risky", allow: [], deny: [] },
        agents: {},
        sandbox: {
          writeJailRoots: [slots.workspace],
          readOnlyRoots: [],
          readAccessMode: "roots_only",
          networkAllowlist: ["127.0.0.1"],
          requireApprovalForRiskyShell: true,
          riskyShellPatterns: ["*"],
          spawnEnvPassthrough: [],
        },
      },
      budgets: {
        mode: "balanced",
        // The campaign proxy is the authoritative shared request/cost cap.
        daily: { tokensWarning: 1_000_000, tokensHardCap: 10_000_000, usdWarning: 10, usdHardCap: 50 },
        session: {
          tokensHardCap: 10_000_000,
          turnMaxInputTokens: profile.contextTokens - profile.outputTokens,
          turnMaxOutputTokens: profile.outputTokens,
        },
      },
      llm: {
        activeProviderId: "comparison",
        activeModel: profile.model,
        defaultThinkingLevel: thinking[profile.reasoning],
        providers: [
          {
            providerId: "comparison",
            label: "Comparison proxy",
            baseUrl: slots.baseUrl,
            apiStyle: "openai-chat-completions",
            authMode: "api-key",
            defaultModel: profile.model,
            apiKeyEnv: "GOATCITADEL_COMPARISON_PROXY_KEY",
            capabilities: {
              vision: false,
              audio: false,
              video: false,
              toolCalling: true,
              jsonMode: true,
              webSearch: false,
              reasoning: profile.reasoning !== "none",
              reasoningEfforts: [profile.reasoning],
            },
          },
        ],
      },
      cronJobs: { jobs: [] },
    },
  };
}
